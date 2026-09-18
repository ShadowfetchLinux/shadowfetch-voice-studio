//! Worker supervisor: spawns `python -m shadowfetch_worker`, speaks the JSON-lines
//! protocol (docs/PROTOCOL.md) over its stdin/stdout, forwards progress/events to the
//! UI, health-checks it and restarts it with backoff when it dies.
//!
//! Free of Tauri types on purpose: the app hands in an [`EventSink`] (the `AppHandle`)
//! and a tokio [`Handle`], which keeps the whole module testable against the real worker.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use log::{debug, error, info, warn};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::runtime::Handle;
use tokio::sync::{oneshot, watch, Mutex as AsyncMutex};
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};

use crate::error::{codes, WorkerError};
use crate::paths::{locate_worker, AppPaths, WorkerLocation};

pub const PROTOCOL_VERSION: u64 = 1;

/// Event names emitted to the webview.
pub const EVENT_PROGRESS: &str = "worker://progress";
pub const EVENT_EVENT: &str = "worker://event";
pub const EVENT_STATUS: &str = "worker://status";

const STDERR_LOG_ROTATE_BYTES: u64 = 20_000_000;

/// Timing/limits of the supervisor. The defaults are the production values; tests shrink them.
#[derive(Debug, Clone)]
pub struct SupervisorConfig {
    /// How long the child may take to print its `ready` line.
    pub ready_timeout: Duration,
    /// Interval between `system.ping` health checks.
    pub health_interval: Duration,
    /// How long a ping may take before the worker counts as unresponsive.
    pub health_timeout: Duration,
    /// Grace period after `{"type":"shutdown"}` before the child is killed.
    pub shutdown_grace: Duration,
    /// Restart delays double from 1 s up to this cap.
    pub max_backoff: Duration,
    /// Crash budget: more than `max_restarts` restarts within this window → give up.
    pub restart_window: Duration,
    pub max_restarts: usize,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            ready_timeout: Duration::from_secs(60),
            health_interval: Duration::from_secs(20),
            health_timeout: Duration::from_secs(10),
            shutdown_grace: Duration::from_secs(3),
            max_backoff: Duration::from_secs(30),
            restart_window: Duration::from_secs(120),
            max_restarts: 5,
        }
    }
}

/// Where UI-bound events go. Implemented for `tauri::AppHandle` in `lib.rs`.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: Value);
}

/// Snapshot of the supervisor, also the payload of `worker://status`.
#[derive(Debug, Clone, Serialize, Default)]
pub struct WorkerStatus {
    /// A worker process is up and answered `ready`.
    pub running: bool,
    /// The supervisor gave up (crash loop, no interpreter, or shutdown); an explicit
    /// `worker_restart` (or a successful bootstrap) is needed.
    pub stopped: bool,
    pub pid: Option<u32>,
    /// Number of (re)spawns after the first successful start.
    pub restarts: u32,
    pub last_error: Option<String>,
    pub started_at_unix_ms: Option<u64>,
    /// Requests waiting for a result.
    pub pending: usize,
    pub python: String,
    pub pythonpath: String,
    pub mode: String,
    pub python_found: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Signal {
    None,
    Restart { manual: bool },
    Shutdown,
}

/// Why the child stopped.
enum ExitReason {
    Exited(ExitStatus),
    Requested { manual: bool },
    Shutdown,
    Failed(String),
}

type Pending = HashMap<String, oneshot::Sender<Result<Value, WorkerError>>>;
/// Finds the worker interpreter; overridable for tests.
pub type Locator = Box<dyn Fn(&AppPaths) -> WorkerLocation + Send + Sync>;

struct Inner {
    sink: Arc<dyn EventSink>,
    handle: Handle,
    paths: AppPaths,
    locator: Locator,
    cfg: SupervisorConfig,
    status: Mutex<WorkerStatus>,
    pending: Mutex<Pending>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    /// Restart/shutdown requests; every `send` wakes the loop (tokio's watch marks a change
    /// even when the value is equal).
    signal: watch::Sender<Signal>,
    shutting_down: AtomicBool,
    /// Unix ms of the last line read from the worker's stdout (liveness hint).
    last_line_ms: AtomicU64,
    restart_times: Mutex<VecDeque<Instant>>,
}

/// Owns the worker process for the lifetime of the app.
pub struct Supervisor {
    inner: Arc<Inner>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Supervisor {
    /// Create a supervisor; call [`Supervisor::start`] to spawn the worker.
    pub fn new(sink: Arc<dyn EventSink>, handle: Handle, paths: AppPaths) -> Self {
        Self::with_locator(
            sink,
            handle,
            paths,
            Box::new(locate_worker),
            SupervisorConfig::default(),
        )
    }

    /// Like [`Supervisor::new`] with a custom interpreter locator and limits (tests, embedding).
    pub fn with_locator(
        sink: Arc<dyn EventSink>,
        handle: Handle,
        paths: AppPaths,
        locator: Locator,
        cfg: SupervisorConfig,
    ) -> Self {
        let (signal, _) = watch::channel(Signal::None);
        Self {
            inner: Arc::new(Inner {
                sink,
                handle,
                paths,
                locator,
                cfg,
                status: Mutex::new(WorkerStatus::default()),
                pending: Mutex::new(HashMap::new()),
                stdin: AsyncMutex::new(None),
                signal,
                shutting_down: AtomicBool::new(false),
                last_line_ms: AtomicU64::new(0),
                restart_times: Mutex::new(VecDeque::new()),
            }),
            task: Mutex::new(None),
        }
    }

    /// Spawn the supervise loop on the runtime (idempotent).
    pub fn start(&self) {
        let mut slot = self.task.lock().unwrap();
        if slot.is_some() {
            return;
        }
        let inner = self.inner.clone();
        *slot = Some(self.inner.handle.spawn(supervise(inner)));
    }

    /// Current status snapshot.
    pub fn status(&self) -> WorkerStatus {
        let mut s = self.inner.status.lock().unwrap().clone();
        s.pending = self.inner.pending.lock().unwrap().len();
        s
    }

    /// Send a request and wait for its result or error.
    pub async fn request(
        &self,
        id: String,
        method: &str,
        params: Value,
    ) -> Result<Value, WorkerError> {
        self.inner.request(id, method, params).await
    }

    /// Best-effort cancel of an in-flight request. `Ok(false)` when nothing is pending under `id`.
    pub async fn cancel(&self, id: &str) -> Result<bool, WorkerError> {
        if !self.inner.pending.lock().unwrap().contains_key(id) {
            return Ok(false);
        }
        let line = json!({ "v": PROTOCOL_VERSION, "type": "cancel", "id": id });
        self.inner.write_line(&line).await.map(|_| true)
    }

    /// Kill the current worker (if any) and start a fresh one immediately, resetting the
    /// crash budget. Also leaves the `stopped` state.
    pub fn restart(&self) {
        info!("worker restart requested");
        self.inner.restart_times.lock().unwrap().clear();
        self.inner.send_signal(Signal::Restart { manual: true });
    }

    /// Graceful shutdown: `{"type":"shutdown"}`, then kill after 3 s. Waits for the loop to end.
    pub async fn shutdown(&self) {
        let inner = self.inner.clone();
        if inner.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        let task = self.task.lock().unwrap().take();
        let _ = inner
            .write_line(&json!({ "v": PROTOCOL_VERSION, "type": "shutdown" }))
            .await;
        inner.send_signal(Signal::Shutdown);
        if let Some(task) = task {
            if timeout(inner.cfg.shutdown_grace + Duration::from_secs(2), task)
                .await
                .is_err()
            {
                warn!("supervisor loop did not finish in time");
            }
        }
        inner.fail_pending("The app is shutting down", true);
    }
}

impl Inner {
    fn send_signal(&self, kind: Signal) {
        let _ = self.signal.send(kind);
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn set_status(&self, f: impl FnOnce(&mut WorkerStatus)) -> WorkerStatus {
        let mut s = self.status.lock().unwrap();
        f(&mut s);
        s.pending = self.pending.lock().unwrap().len();
        s.clone()
    }

    fn emit_status(&self) {
        let s = self.set_status(|_| {});
        self.sink.emit(
            EVENT_STATUS,
            serde_json::to_value(&s).unwrap_or(Value::Null),
        );
    }

    fn is_stopped(&self) -> bool {
        self.status.lock().unwrap().stopped
    }

    async fn write_line(&self, msg: &Value) -> Result<(), WorkerError> {
        let mut line = serde_json::to_string(msg)
            .map_err(|e| WorkerError::internal(format!("cannot encode request: {e}")))?;
        line.push('\n');
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or_else(|| {
            WorkerError::worker_down("The worker is not running.", self.is_stopped())
        })?;
        let res = async {
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await
        }
        .await;
        if let Err(e) = res {
            *guard = None;
            return Err(WorkerError::worker_down(
                format!("Lost the connection to the worker: {e}"),
                self.is_stopped(),
            ));
        }
        Ok(())
    }

    async fn request(&self, id: String, method: &str, params: Value) -> Result<Value, WorkerError> {
        if !self.status.lock().unwrap().running {
            let s = self.status.lock().unwrap().clone();
            let msg = match &s.last_error {
                Some(e) => format!("The worker is not running ({e})."),
                None => "The worker is not running.".to_string(),
            };
            return Err(WorkerError::worker_down(msg, s.stopped));
        }
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let line = json!({
            "v": PROTOCOL_VERSION, "type": "request", "id": id, "method": method, "params": params
        });
        if let Err(e) = self.write_line(&line).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        match rx.await {
            Ok(res) => res,
            Err(_) => Err(WorkerError::worker_down(
                "The worker stopped before answering.",
                self.is_stopped(),
            )),
        }
    }

    /// Fail every pending request with `WORKER_DOWN`.
    fn fail_pending(&self, why: &str, stopped: bool) {
        let drained: Vec<_> = self.pending.lock().unwrap().drain().collect();
        if !drained.is_empty() {
            warn!("failing {} pending request(s): {why}", drained.len());
        }
        for (_, tx) in drained {
            let _ = tx.send(Err(WorkerError::worker_down(why, stopped)));
        }
    }

    /// Restart delay under the crash budget, or `None` when the budget is exhausted.
    fn backoff_delay(&self) -> Option<Duration> {
        let mut times = self.restart_times.lock().unwrap();
        let now = Instant::now();
        while times
            .front()
            .is_some_and(|t| now.duration_since(*t) > self.cfg.restart_window)
        {
            times.pop_front();
        }
        if times.len() >= self.cfg.max_restarts {
            return None;
        }
        let delay = Duration::from_secs(1u64 << times.len().min(5)).min(self.cfg.max_backoff);
        times.push_back(now);
        Some(delay)
    }

    /// Handle one protocol line from the worker's stdout.
    fn handle_line(&self, line: &str, ready_tx: &mut Option<oneshot::Sender<Value>>) {
        let msg: Value = match serde_json::from_str(line) {
            Ok(Value::Object(m)) => Value::Object(m),
            _ => {
                warn!("dropping non-protocol stdout line: {}", truncate(line, 200));
                return;
            }
        };
        let kind = msg.get("type").and_then(Value::as_str).unwrap_or("");
        let id = msg.get("id").and_then(Value::as_str);
        match kind {
            "ready" => {
                if msg.get("protocol").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
                    warn!("worker protocol version mismatch: {msg}");
                }
                if let Some(tx) = ready_tx.take() {
                    let _ = tx.send(msg);
                } else {
                    warn!("worker sent a second ready line");
                }
            }
            "result" | "error" => {
                let Some(id) = id else {
                    warn!("{kind} line without id: {}", truncate(line, 200));
                    return;
                };
                let outcome = if kind == "result" {
                    Ok(msg.get("result").cloned().unwrap_or(json!({})))
                } else {
                    Err(WorkerError::from_protocol(
                        msg.get("error").unwrap_or(&Value::Null),
                    ))
                };
                match self.pending.lock().unwrap().remove(id) {
                    Some(tx) => {
                        let _ = tx.send(outcome);
                    }
                    None => debug!("{kind} for unknown/cancelled request {id}"),
                }
            }
            "progress" => {
                let mut payload = msg.clone();
                if let Some(m) = payload.as_object_mut() {
                    m.remove("v");
                    m.remove("type");
                }
                self.sink.emit(EVENT_PROGRESS, payload);
            }
            "event" => {
                let payload = json!({
                    "event": msg.get("event").cloned().unwrap_or(Value::Null),
                    "data": msg.get("data").cloned().unwrap_or(json!({})),
                });
                self.sink.emit(EVENT_EVENT, payload);
            }
            other => warn!("unknown worker message type {other:?}"),
        }
    }

    /// Spawn the child, wait for `ready`, then run until it exits or is told to stop.
    async fn run_child(
        self: &Arc<Self>,
        location: &WorkerLocation,
        sig_rx: &mut watch::Receiver<Signal>,
    ) -> ExitReason {
        let mut child = match spawn_worker(&self.paths, location) {
            Ok(c) => c,
            Err(e) => return ExitReason::Failed(e),
        };
        let pid = child.id();
        info!(
            "worker spawned pid={pid:?} python={} mode={}",
            location.python.display(),
            location.mode
        );

        if let Some(stderr) = child.stderr.take() {
            let log_path = self.paths.worker_stderr_log();
            self.handle.spawn(pipe_stderr(stderr, log_path, pid));
        }
        let (ready_tx, ready_rx) = oneshot::channel::<Value>();
        let reader = match child.stdout.take() {
            Some(stdout) => {
                let me = self.clone();
                self.handle
                    .spawn(async move { me.read_stdout(stdout, ready_tx).await })
            }
            None => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return ExitReason::Failed("worker stdout was not captured".into());
            }
        };
        *self.stdin.lock().await = child.stdin.take();

        // -- handshake
        let ready = tokio::select! {
            r = timeout(self.cfg.ready_timeout, ready_rx) => match r {
                Ok(Ok(info)) => Ok(info),
                Ok(Err(_)) => Err("worker closed stdout before reporting ready".to_string()),
                Err(_) => Err(format!(
                    "worker did not report ready within {}s",
                    self.cfg.ready_timeout.as_secs()
                )),
            },
            status = child.wait() => Err(match status {
                Ok(s) => format!("worker exited before reporting ready ({})", describe_exit(&s)),
                Err(e) => format!("waiting for the worker failed: {e}"),
            }),
            _ = sig_rx.changed() => Err("interrupted during startup".to_string()),
        };
        let ready = match ready {
            Ok(v) => v,
            Err(e) => {
                let _ = child.start_kill();
                let status = child.wait().await.ok();
                *self.stdin.lock().await = None;
                reader.abort();
                // A child that died right away closes stdout first; report its exit status.
                let e = match status {
                    Some(s) if e.starts_with("worker closed stdout") => {
                        format!(
                            "worker exited before reporting ready ({})",
                            describe_exit(&s)
                        )
                    }
                    _ => e,
                };
                let kind = *sig_rx.borrow_and_update();
                return match kind {
                    Signal::Shutdown => ExitReason::Shutdown,
                    Signal::Restart { manual } if e.starts_with("interrupted") => {
                        ExitReason::Requested { manual }
                    }
                    _ => ExitReason::Failed(e),
                };
            }
        };
        info!("worker ready: {ready}");
        self.last_line_ms.store(Self::now_ms(), Ordering::Relaxed);
        self.set_status(|s| {
            s.running = true;
            s.stopped = false;
            s.pid = pid;
            s.last_error = None;
            s.started_at_unix_ms = Some(Self::now_ms());
        });
        self.emit_status();

        // -- steady state: health pings until exit or signal
        let (exit_tx, exit_rx) = watch::channel(false);
        self.handle.spawn(self.clone().health_loop(exit_rx));
        let reason = tokio::select! {
            status = child.wait() => match status {
                Ok(s) => ExitReason::Exited(s),
                Err(e) => ExitReason::Failed(format!("waiting for the worker failed: {e}")),
            },
            _ = sig_rx.changed() => {
                let kind = *sig_rx.borrow_and_update();
                match kind {
                    Signal::Shutdown => {
                        // `shutdown` already wrote the shutdown line; give it a moment.
                        if timeout(self.cfg.shutdown_grace, child.wait()).await.is_err() {
                            warn!("worker ignored shutdown; killing it");
                            let _ = child.start_kill();
                            let _ = child.wait().await;
                        }
                        ExitReason::Shutdown
                    }
                    Signal::Restart { manual } => {
                        let _ = child.start_kill();
                        let _ = child.wait().await;
                        ExitReason::Requested { manual }
                    }
                    Signal::None => ExitReason::Failed("spurious signal".into()),
                }
            }
        };
        let _ = exit_tx.send(true);
        *self.stdin.lock().await = None;
        // Let the reader drain what is left; it ends on EOF.
        let _ = timeout(Duration::from_secs(2), reader).await;
        reason
    }

    async fn read_stdout(self: Arc<Self>, stdout: ChildStdout, ready_tx: oneshot::Sender<Value>) {
        let mut lines = BufReader::with_capacity(1 << 16, stdout).lines();
        let mut ready_tx = Some(ready_tx);
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    self.last_line_ms.store(Self::now_ms(), Ordering::Relaxed);
                    if !line.trim().is_empty() {
                        self.handle_line(&line, &mut ready_tx);
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    warn!("reading worker stdout failed: {e}");
                    break;
                }
            }
        }
        debug!("worker stdout closed");
    }

    /// `system.ping` every 20 s with a 10 s timeout. A timeout only triggers a restart when the
    /// worker has been completely silent meanwhile; a busy worker that still streams
    /// progress is left alone.
    async fn health_loop(self: Arc<Self>, mut exit_rx: watch::Receiver<bool>) {
        loop {
            tokio::select! {
                _ = sleep(self.cfg.health_interval) => {}
                _ = exit_rx.changed() => return,
            }
            if *exit_rx.borrow() {
                return;
            }
            let before = self.last_line_ms.load(Ordering::Relaxed);
            let id = uuid::Uuid::new_v4().to_string();
            match timeout(
                self.cfg.health_timeout,
                self.request(id.clone(), "system.ping", json!({})),
            )
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(e)) if e.code == codes::WORKER_DOWN => return,
                Ok(Err(e)) => warn!("health ping answered with an error: {e}"),
                Err(_) => {
                    self.pending.lock().unwrap().remove(&id);
                    if self.last_line_ms.load(Ordering::Relaxed) > before {
                        warn!(
                            "health ping timed out but the worker is still talking; not restarting"
                        );
                        continue;
                    }
                    error!("health ping timed out with a silent worker; restarting it");
                    self.send_signal(Signal::Restart { manual: false });
                    return;
                }
            }
        }
    }
}

/// The supervise loop: spawn, run, restart with backoff, give up when crash-looping.
async fn supervise(inner: Arc<Inner>) {
    let mut sig_rx = inner.signal.subscribe();
    loop {
        if inner.shutting_down.load(Ordering::SeqCst) {
            break;
        }
        sig_rx.borrow_and_update();
        let location = (inner.locator)(&inner.paths);
        inner.set_status(|s| {
            s.python = location.python.display().to_string();
            s.pythonpath = location.pythonpath.display().to_string();
            s.mode = location.mode.to_string();
            s.python_found = location.found;
        });

        let reason = if location.found {
            inner.run_child(&location, &mut sig_rx).await
        } else {
            ExitReason::Failed(format!(
                "worker runtime not found (python: {}, package dir: {}); run the runtime bootstrap",
                location.python.display(),
                location.pythonpath.display()
            ))
        };

        let (message, manual) = match &reason {
            ExitReason::Exited(s) => (format!("worker exited ({})", describe_exit(s)), false),
            ExitReason::Requested { manual } => {
                ("worker restarted on request".to_string(), *manual)
            }
            ExitReason::Shutdown => ("shutdown".to_string(), false),
            ExitReason::Failed(e) => (e.clone(), false),
        };
        let was_running = inner.status.lock().unwrap().running;
        if was_running {
            inner.set_status(|s| s.restarts += 1);
        }
        info!("worker down: {message}");
        inner.fail_pending(&message, false);
        inner.set_status(|s| {
            s.running = false;
            s.pid = None;
            s.started_at_unix_ms = None;
            s.last_error = Some(message.clone());
        });
        if matches!(reason, ExitReason::Shutdown) || inner.shutting_down.load(Ordering::SeqCst) {
            inner.set_status(|s| s.stopped = true);
            inner.emit_status();
            break;
        }

        // -- decide how (and whether) to come back
        let delay = if manual {
            Some(Duration::ZERO)
        } else if !location.found {
            None
        } else {
            inner.backoff_delay()
        };
        match delay {
            Some(d) => {
                inner.set_status(|s| s.stopped = false);
                inner.emit_status();
                if !d.is_zero() {
                    info!("restarting the worker in {:.0}s", d.as_secs_f64());
                    tokio::select! {
                        _ = sleep(d) => {}
                        _ = sig_rx.changed() => {
                            if *sig_rx.borrow() == Signal::Shutdown { break; }
                            inner.restart_times.lock().unwrap().clear();
                        }
                    }
                }
            }
            None => {
                if location.found {
                    error!(
                        "worker crashed {} times within {}s; giving up until restarted",
                        inner.cfg.max_restarts,
                        inner.cfg.restart_window.as_secs()
                    );
                    inner.set_status(|s| {
                        s.last_error = Some(format!(
                            "{message}; the worker crashed repeatedly and was stopped"
                        ))
                    });
                }
                inner.set_status(|s| s.stopped = true);
                inner.emit_status();
                if sig_rx.changed().await.is_err() {
                    break;
                }
                if *sig_rx.borrow() == Signal::Shutdown {
                    break;
                }
                inner.restart_times.lock().unwrap().clear();
            }
        }
    }
    inner.set_status(|s| {
        s.running = false;
        s.stopped = true;
    });
    debug!("supervisor loop ended");
}

/// Build and spawn the worker command.
fn spawn_worker(paths: &AppPaths, location: &WorkerLocation) -> Result<Child, String> {
    let mut pythonpath = location.pythonpath.as_os_str().to_owned();
    if let Some(existing) = std::env::var_os("PYTHONPATH") {
        if !existing.is_empty() {
            pythonpath.push(":");
            pythonpath.push(existing);
        }
    }
    let mut cmd = Command::new(&location.python);
    cmd.arg("-m")
        .arg("shadowfetch_worker")
        .arg("--data-dir")
        .arg(&paths.data)
        .arg("--config-dir")
        .arg(&paths.config)
        .arg("--cache-dir")
        .arg(&paths.cache)
        .env("PYTHONPATH", pythonpath)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONNOUSERSITE", "1")
        .env(crate::paths::ENV_RUNTIME_DIR, &paths.runtime_root)
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("DO_NOT_TRACK", "1")
        .current_dir(&paths.data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd.spawn()
        .map_err(|e| format!("failed to start {}: {e}", location.python.display()))
}

/// Append the child's stderr to `<data>/logs/shell-worker.log` (rotated once past 20 MB).
async fn pipe_stderr(stderr: ChildStderr, log_path: PathBuf, pid: Option<u32>) {
    if let Ok(meta) = tokio::fs::metadata(&log_path).await {
        if meta.len() > STDERR_LOG_ROTATE_BYTES {
            let rotated = log_path.with_extension("log.1");
            let _ = tokio::fs::rename(&log_path, &rotated).await;
        }
    }
    let mut file = match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .await
    {
        Ok(f) => f,
        Err(e) => {
            warn!(
                "cannot open {}: {e}; worker stderr is discarded",
                log_path.display()
            );
            let mut sink = tokio::io::sink();
            let mut stderr = stderr;
            let _ = tokio::io::copy(&mut stderr, &mut sink).await;
            return;
        }
    };
    let header = format!(
        "\n=== worker pid={} started at unix {} ===\n",
        pid.map(|p| p.to_string()).unwrap_or_else(|| "?".into()),
        Inner::now_ms() / 1000
    );
    let _ = file.write_all(header.as_bytes()).await;
    let mut stderr = stderr;
    if let Err(e) = tokio::io::copy(&mut stderr, &mut file).await {
        debug!("worker stderr pipe ended: {e}");
    }
    let _ = file.flush().await;
}

fn describe_exit(status: &ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
        (Some(code), _) => format!("exit code {code}"),
        (None, Some(sig)) => format!("killed by signal {sig}"),
        _ => "unknown exit status".to_string(),
    }
}

fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}
