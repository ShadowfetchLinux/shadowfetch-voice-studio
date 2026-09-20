//! Integration tests for the worker supervisor, driven by `fake_worker.py` (fast, deterministic)
//! plus one round-trip against the real Python worker when `backend/.venv-spine` exists.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sfvs_supervisor_harness::error::codes;
use sfvs_supervisor_harness::paths::{AppPaths, WorkerLocation};
use sfvs_supervisor_harness::worker::{
    EventSink, Supervisor, SupervisorConfig, EVENT_EVENT, EVENT_PROGRESS, EVENT_STATUS,
};
use tokio::time::sleep;

const FAKE_WORKER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fake_worker.py");

// ------------------------------------------------------------------ fixtures

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<(String, Value)>>,
}

impl Recorder {
    fn named(&self, name: &str) -> Vec<Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
            .collect()
    }
}

impl EventSink for Recorder {
    fn emit(&self, event: &str, payload: Value) {
        self.events
            .lock()
            .unwrap()
            .push((event.to_string(), payload));
    }
}

struct Fixture {
    root: PathBuf,
    paths: AppPaths,
    recorder: Arc<Recorder>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn fixture(tag: &str) -> Fixture {
    let root = std::env::temp_dir().join(format!(
        "sfvs-harness-{tag}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    // A python package dir whose `shadowfetch_worker/__main__.py` is the fake worker.
    let pkg = root.join("backend/shadowfetch_worker");
    std::fs::create_dir_all(&pkg).unwrap();
    std::fs::write(pkg.join("__init__.py"), "").unwrap();
    std::fs::copy(FAKE_WORKER, pkg.join("__main__.py")).unwrap();
    let paths = AppPaths::new(
        root.join("data"),
        root.join("config"),
        root.join("cache"),
        root.join("resource"),
    );
    paths.ensure().unwrap();
    Fixture {
        root,
        paths,
        recorder: Arc::new(Recorder::default()),
    }
}

fn location(python: &Path, backend: &Path) -> WorkerLocation {
    WorkerLocation {
        python: python.to_path_buf(),
        pythonpath: backend.to_path_buf(),
        mode: "dev",
        source: "env",
        found: python.is_file() && backend.join("shadowfetch_worker/__main__.py").is_file(),
        python_found: python.is_file(),
        package_found: true,
        standalone: true,
    }
}

fn fast_config() -> SupervisorConfig {
    SupervisorConfig {
        ready_timeout: Duration::from_secs(20),
        health_interval: Duration::from_millis(500),
        health_timeout: Duration::from_millis(800),
        shutdown_grace: Duration::from_secs(1),
        max_backoff: Duration::from_secs(1),
        restart_window: Duration::from_secs(60),
        max_restarts: 3,
    }
}

fn fake_supervisor(fx: &Fixture, cfg: SupervisorConfig) -> Supervisor {
    let backend = fx.root.join("backend");
    let python = PathBuf::from("/usr/bin/python3");
    let sup = Supervisor::with_locator(
        fx.recorder.clone(),
        tokio::runtime::Handle::current(),
        fx.paths.clone(),
        Box::new(move |_| location(&python, &backend)),
        cfg,
    );
    sup.start();
    sup
}

async fn wait_until(what: &str, limit: Duration, mut pred: impl FnMut() -> bool) {
    let start = Instant::now();
    while !pred() {
        assert!(start.elapsed() < limit, "timed out waiting for {what}");
        sleep(Duration::from_millis(25)).await;
    }
}

async fn wait_running(sup: &Supervisor) -> u32 {
    wait_until("worker running", Duration::from_secs(20), || {
        sup.status().running
    })
    .await;
    sup.status().pid.expect("pid")
}

fn pid_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ------------------------------------------------------------------ tests

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ping_progress_events_cancel_and_shutdown() {
    let fx = fixture("basic");
    let sup = fake_supervisor(&fx, fast_config());
    let pid = wait_running(&sup).await;
    assert!(pid_alive(pid));
    let status = sup.status();
    assert_eq!(status.mode, "dev");
    assert!(status.python_found && !status.stopped && status.restarts == 0);

    // result
    let r = sup.request(id(), "system.ping", json!({})).await.unwrap();
    assert_eq!(r["ok"], json!(true));
    let r = sup
        .request(id(), "test.echo", json!({"x": 1}))
        .await
        .unwrap();
    assert_eq!(r["params"]["x"], json!(1));
    assert_eq!(r["data_dir"], json!(fx.paths.data.display().to_string()));

    // protocol error passes through untouched
    let e = sup.request(id(), "nope.x", json!({})).await.unwrap_err();
    assert_eq!(e.code, "NOT_FOUND");
    assert!(!e.recoverable);

    // progress lines become worker://progress events carrying the request id
    let rid = id();
    let r = sup
        .request(
            rid.clone(),
            "test.sleep",
            json!({"seconds": 0.3, "steps": 3}),
        )
        .await
        .unwrap();
    assert_eq!(r["slept"], json!(0.3));
    let progress = fx.recorder.named(EVENT_PROGRESS);
    let mine: Vec<_> = progress.iter().filter(|p| p["id"] == json!(rid)).collect();
    assert_eq!(mine.len(), 3, "{progress:?}");
    assert_eq!(mine[2]["current"], json!(3));
    assert_eq!(mine[2]["total"], json!(3));
    assert_eq!(mine[2]["stage"], json!("sleep"));
    assert!(mine[0].get("v").is_none() && mine[0].get("type").is_none());

    // unsolicited events become worker://event {event, data}
    sup.request(
        id(),
        "test.event",
        json!({"event": "engine.state", "data": {"engine_id": "x", "state": "loaded"}}),
    )
    .await
    .unwrap();
    let events = fx.recorder.named(EVENT_EVENT);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event"], json!("engine.state"));
    assert_eq!(events[0]["data"]["state"], json!("loaded"));

    // cancel: the request ends with CANCELLED and keeps the partial count
    let rid = id();
    let sup = Arc::new(sup);
    let s2 = sup.clone();
    let rid2 = rid.clone();
    let job = tokio::spawn(async move {
        s2.request(rid2, "test.sleep", json!({"seconds": 10, "steps": 100}))
            .await
    });
    sleep(Duration::from_millis(350)).await;
    assert_eq!(sup.status().pending, 1);
    assert!(sup.cancel(&rid).await.unwrap());
    let e = job.await.unwrap().unwrap_err();
    assert_eq!(e.code, "CANCELLED");
    assert!(e.details["done"].as_u64().unwrap() >= 1);
    assert!(!sup.cancel(&id()).await.unwrap(), "unknown id → false");

    // graceful shutdown
    sup.shutdown().await;
    let s = sup.status();
    assert!(!s.running && s.stopped);
    wait_until("worker process exit", Duration::from_secs(5), || {
        !pid_alive(pid)
    })
    .await;
    let e = sup
        .request(id(), "system.ping", json!({}))
        .await
        .unwrap_err();
    assert_eq!(e.code, codes::WORKER_DOWN);
    assert_eq!(e.details["stopped"], json!(true));

    // stderr landed in the shell log
    let log = std::fs::read_to_string(fx.paths.worker_stderr_log()).unwrap();
    assert!(log.contains("=== worker pid="), "{log}");
    assert!(log.contains("fake worker ready"), "{log}");
    assert!(log.contains("fake worker shutdown"), "{log}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crash_fails_pending_and_restarts() {
    let fx = fixture("crash");
    let sup = Arc::new(fake_supervisor(&fx, fast_config()));
    let pid1 = wait_running(&sup).await;

    let s2 = sup.clone();
    let pending = tokio::spawn(async move {
        s2.request(id(), "test.sleep", json!({"seconds": 30, "steps": 300}))
            .await
    });
    sleep(Duration::from_millis(200)).await;
    let e = sup
        .request(id(), "test.crash", json!({"code": 3}))
        .await
        .unwrap_err();
    assert_eq!(e.code, codes::WORKER_DOWN);
    let e = pending.await.unwrap().unwrap_err();
    assert_eq!(
        e.code,
        codes::WORKER_DOWN,
        "in-flight request fails on crash"
    );

    wait_until("restart", Duration::from_secs(15), || {
        let s = sup.status();
        s.running && s.pid != Some(pid1)
    })
    .await;
    let s = sup.status();
    assert_eq!(s.restarts, 1);
    assert!(!s.stopped);
    assert!(pid_alive(s.pid.unwrap()) && !pid_alive(pid1));

    let statuses = fx.recorder.named(EVENT_STATUS);
    let down = statuses
        .iter()
        .find(|s| s["running"] == json!(false))
        .expect("a running:false status event");
    assert!(down["last_error"].as_str().unwrap().contains("exit code 3"));
    assert_eq!(statuses.last().unwrap()["running"], json!(true));

    let r = sup.request(id(), "system.ping", json!({})).await.unwrap();
    assert_eq!(r["ok"], json!(true));
    sup.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manual_restart_replaces_the_process() {
    let fx = fixture("manual");
    let sup = fake_supervisor(&fx, fast_config());
    let pid1 = wait_running(&sup).await;
    sup.restart();
    wait_until("new pid", Duration::from_secs(10), || {
        let s = sup.status();
        s.running && s.pid != Some(pid1)
    })
    .await;
    assert_eq!(sup.status().restarts, 1);
    assert!(!pid_alive(pid1));
    sup.shutdown().await;
}

/// A "python" wrapper that makes the fake worker print `ready` only after `delay_s`.
fn slow_python(fx: &Fixture, delay_s: f64) -> PathBuf {
    let wrapper = fx.root.join("slow-python.sh");
    std::fs::write(
        &wrapper,
        format!("#!/bin/sh\nFAKE_WORKER_READY_DELAY={delay_s} exec /usr/bin/python3 \"$@\"\n"),
    )
    .unwrap();
    std::fs::set_permissions(
        &wrapper,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    wrapper
}

fn slow_supervisor(fx: &Fixture, delay_s: f64, cfg: SupervisorConfig) -> Supervisor {
    let backend = fx.root.join("backend");
    let python = slow_python(fx, delay_s);
    let sup = Supervisor::with_locator(
        fx.recorder.clone(),
        tokio::runtime::Handle::current(),
        fx.paths.clone(),
        Box::new(move |_| location(&python, &backend)),
        cfg,
    );
    sup.start();
    sup
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn requests_wait_for_a_starting_worker() {
    let fx = fixture("starting");
    let sup = slow_supervisor(&fx, 1.0, fast_config());
    // The UI boots long before python is ready: the request must wait, not fail.
    assert!(!sup.status().running);
    let started = Instant::now();
    let r = sup.request(id(), "system.ping", json!({})).await.unwrap();
    assert_eq!(r["ok"], json!(true));
    assert!(
        started.elapsed() >= Duration::from_millis(900),
        "did not wait for ready"
    );
    let pid1 = sup.status().pid.expect("pid");

    // Same for the window right after "Restart worker": the request goes to the new process.
    sup.restart();
    assert!(
        !sup.status().running,
        "restart() marks the worker down at once"
    );
    let r = sup.request(id(), "system.ping", json!({})).await.unwrap();
    assert_eq!(r["ok"], json!(true));
    let s = sup.status();
    assert!(s.running && s.pid != Some(pid1) && s.restarts == 1, "{s:?}");
    assert!(!pid_alive(pid1));
    sup.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn waiting_requests_fail_once_the_worker_stays_down() {
    let fx = fixture("never-ready");
    let cfg = SupervisorConfig {
        ready_timeout: Duration::from_secs(1),
        max_restarts: 1,
        ..fast_config()
    };
    // Ready takes longer than the supervisor tolerates: every attempt is killed.
    let sup = slow_supervisor(&fx, 5.0, cfg);
    let started = Instant::now();
    let e = sup
        .request(id(), "system.ping", json!({}))
        .await
        .unwrap_err();
    assert_eq!(e.code, codes::WORKER_DOWN);
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "waited past ready_timeout"
    );
    wait_until("give up", Duration::from_secs(10), || sup.status().stopped).await;
    // Once stopped a request fails immediately.
    let started = Instant::now();
    let e = sup
        .request(id(), "system.ping", json!({}))
        .await
        .unwrap_err();
    assert_eq!(e.code, codes::WORKER_DOWN);
    assert_eq!(e.details["stopped"], json!(true));
    assert!(started.elapsed() < Duration::from_millis(200));
    sup.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gives_up_after_a_crash_loop_until_restarted() {
    let fx = fixture("loop");
    // "python" that exits 3 straight away: every attempt fails before ready.
    let crasher = fx.root.join("crash.sh");
    std::fs::write(&crasher, "#!/bin/sh\nexit 3\n").unwrap();
    std::fs::set_permissions(
        &crasher,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    let backend = fx.root.join("backend");
    let good = PathBuf::from("/usr/bin/python3");
    let current = Arc::new(Mutex::new(crasher.clone()));
    let cur = current.clone();
    let sup = Supervisor::with_locator(
        fx.recorder.clone(),
        tokio::runtime::Handle::current(),
        fx.paths.clone(),
        Box::new(move |_| location(&cur.lock().unwrap(), &backend)),
        fast_config(),
    );
    sup.start();
    // 3 restarts allowed (1s + 1s + 1s backoff with max_backoff = 1s), then stopped.
    wait_until("give up", Duration::from_secs(15), || sup.status().stopped).await;
    let s = sup.status();
    assert!(!s.running);
    assert!(
        s.last_error.as_deref().unwrap().contains("exit code 3"),
        "{s:?}"
    );
    assert!(
        s.last_error
            .as_deref()
            .unwrap()
            .contains("crashed repeatedly"),
        "{s:?}"
    );
    let e = sup
        .request(id(), "system.ping", json!({}))
        .await
        .unwrap_err();
    assert_eq!(e.code, codes::WORKER_DOWN);
    assert_eq!(e.details["stopped"], json!(true));
    sleep(Duration::from_millis(500)).await;
    assert!(
        sup.status().stopped,
        "stays stopped without a restart request"
    );

    // fix the interpreter and ask for a restart
    *current.lock().unwrap() = good;
    sup.restart();
    wait_running(&sup).await;
    assert!(!sup.status().stopped);
    sup.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopped_when_the_interpreter_is_missing() {
    let fx = fixture("missing");
    let backend = fx.root.join("backend");
    let missing = fx.root.join("nope/bin/python");
    let sup = Supervisor::with_locator(
        fx.recorder.clone(),
        tokio::runtime::Handle::current(),
        fx.paths.clone(),
        Box::new(move |_| location(&missing, &backend)),
        fast_config(),
    );
    sup.start();
    wait_until("stopped", Duration::from_secs(5), || sup.status().stopped).await;
    let s = sup.status();
    assert!(!s.running && !s.python_found);
    assert!(
        s.last_error.as_deref().unwrap().contains("not found"),
        "{s:?}"
    );
    let e = sup
        .request(id(), "system.ping", json!({}))
        .await
        .unwrap_err();
    assert_eq!(e.code, codes::WORKER_DOWN);
    assert_eq!(e.details["stopped"], json!(true));
    sup.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn health_check_restarts_a_silent_worker() {
    let fx = fixture("health");
    let sup = fake_supervisor(&fx, fast_config());
    let pid1 = wait_running(&sup).await;
    // test.hang never answers, so this request only ends when the supervisor kills the child.
    let e = sup.request(id(), "test.hang", json!({})).await.unwrap_err();
    assert_eq!(e.code, codes::WORKER_DOWN);
    wait_until("health restart", Duration::from_secs(10), || {
        let s = sup.status();
        s.running && s.pid != Some(pid1)
    })
    .await;
    assert_eq!(sup.status().restarts, 1);
    sup.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn busy_worker_that_streams_progress_is_not_restarted() {
    let fx = fixture("busy");
    let sup = fake_supervisor(&fx, fast_config());
    let pid = wait_running(&sup).await;
    // 3 s of progress at 10 Hz while pings go unanswered (interval 0.5 s, timeout 0.8 s).
    let r = sup
        .request(id(), "test.busy", json!({"seconds": 3, "steps": 30}))
        .await
        .unwrap();
    assert_eq!(r["busy_s"], json!(3.0));
    let s = sup.status();
    assert_eq!(s.restarts, 0, "{s:?}");
    assert_eq!(s.pid, Some(pid));
    sup.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_kills_a_worker_that_ignores_it() {
    let fx = fixture("deaf");
    let sup = fake_supervisor(&fx, fast_config());
    let pid = wait_running(&sup).await;
    sup.request(id(), "test.deaf", json!({})).await.unwrap();
    let t = Instant::now();
    sup.shutdown().await;
    let took = t.elapsed();
    assert!(
        took >= Duration::from_millis(900) && took < Duration::from_secs(4),
        "{took:?}"
    );
    wait_until("process gone", Duration::from_secs(5), || !pid_alive(pid)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_worker_round_trip() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let backend = repo.join("backend").canonicalize().unwrap();
    let python = backend.join(".venv-spine/bin/python");
    if !python.is_file() {
        eprintln!("skipping: {} not found", python.display());
        return;
    }
    let fx = fixture("real");
    let sup = Supervisor::with_locator(
        fx.recorder.clone(),
        tokio::runtime::Handle::current(),
        fx.paths.clone(),
        Box::new(move |_| location(&python, &backend)),
        SupervisorConfig::default(),
    );
    sup.start();
    let pid = wait_running(&sup).await;
    let r = sup.request(id(), "system.ping", json!({})).await.unwrap();
    assert_eq!(r["ok"], json!(true));
    assert_eq!(r["pid"], json!(pid));
    let e = sup.request(id(), "nope.x", json!({})).await.unwrap_err();
    assert_eq!(e.code, "NOT_FOUND");
    sup.shutdown().await;
    wait_until("real worker exit", Duration::from_secs(10), || {
        !pid_alive(pid)
    })
    .await;
    assert!(
        fx.paths.data.join("logs/worker.log").is_file(),
        "worker wrote its own log"
    );
    assert!(fx.paths.worker_stderr_log().is_file());
}
