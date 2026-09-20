//! Typed `#[tauri::command]`s — the only surface the webview can call.
//!
//! Every path-taking command re-validates its argument against the managed app
//! directories or the paths the user picked through a native dialog *in this session*.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use log::{info, warn};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::error::{codes, WorkerError};
use crate::paths::{locate_worker, AppPaths, WorkerLocation};
use crate::worker::{Supervisor, WorkerStatus};

/// Event carrying one line of bootstrap output: `{stream: "stdout"|"stderr"|"system", line}`.
pub const EVENT_RUNTIME_LOG: &str = "runtime://log";
const MAX_TEXT_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_TITLE_CHARS: usize = 200;

/// Shared shell state (managed by Tauri).
pub struct ShellState {
    pub paths: AppPaths,
    pub supervisor: Arc<Supervisor>,
    /// Canonical roots the UI may open/reveal: data/config/cache + dirs picked this session.
    allowed_dirs: Mutex<HashSet<PathBuf>>,
    /// Files picked via `pick_audio_files`/`pick_save_path` (open/reveal allowed).
    picked_files: Mutex<HashSet<PathBuf>>,
    /// Files picked via `pick_text_file` (the only ones `read_text_file` will read).
    text_files: Mutex<HashSet<PathBuf>>,
    bootstrap_running: AtomicBool,
}

impl ShellState {
    pub fn new(paths: AppPaths, supervisor: Arc<Supervisor>) -> Self {
        let allowed_dirs = paths
            .managed_roots()
            .into_iter()
            .map(|p| p.canonicalize().unwrap_or(p))
            .collect();
        Self {
            paths,
            supervisor,
            allowed_dirs: Mutex::new(allowed_dirs),
            picked_files: Mutex::new(HashSet::new()),
            text_files: Mutex::new(HashSet::new()),
            bootstrap_running: AtomicBool::new(false),
        }
    }

    fn allow_dir(&self, dir: &Path) {
        let dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
        self.allowed_dirs.lock().unwrap().insert(dir);
    }

    fn remember_file(&self, set: &Mutex<HashSet<PathBuf>>, file: &Path) {
        let file = file.canonicalize().unwrap_or_else(|_| file.to_path_buf());
        set.lock().unwrap().insert(file);
    }

    /// True when `path` (canonicalized if it exists) is under an allowed root or was picked.
    fn may_open(&self, path: &Path) -> bool {
        let canon = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        if self.picked_files.lock().unwrap().contains(&canon) {
            return true;
        }
        self.allowed_dirs
            .lock()
            .unwrap()
            .iter()
            .any(|root| canon.starts_with(root))
    }
}

fn absolute(path: &str) -> Result<PathBuf, WorkerError> {
    let p = PathBuf::from(path);
    if path.is_empty() || !p.is_absolute() {
        return Err(WorkerError::invalid("Expected an absolute path."));
    }
    Ok(p)
}

/// Accept the id exactly as given (so events correlate with what the UI generated) once it parses as a UUID.
fn validate_uuid(id: &str) -> Result<String, WorkerError> {
    uuid::Uuid::parse_str(id)
        .map(|_| id.to_string())
        .map_err(|_| WorkerError::invalid(format!("Request id is not a UUID: {id:?}")))
}

fn validate_method(method: &str) -> Result<(), WorkerError> {
    let ok = !method.is_empty()
        && method.len() <= 64
        && method.contains('.')
        && !method.starts_with('.')
        && !method.ends_with('.')
        && method
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.');
    if ok {
        Ok(())
    } else {
        Err(WorkerError::invalid(format!(
            "Invalid method name {method:?}"
        )))
    }
}

// ---------------------------------------------------------------- worker

/// Send a protocol request to the worker and return its result.
/// `id` must be a UUID (generated when omitted); use the same id for `worker_cancel` and to
/// correlate `worker://progress` events.
#[tauri::command]
pub async fn worker_request(
    state: State<'_, ShellState>,
    id: Option<String>,
    method: String,
    params: Option<Value>,
) -> Result<Value, WorkerError> {
    let id = match id {
        Some(id) => validate_uuid(&id)?,
        None => uuid::Uuid::new_v4().to_string(),
    };
    validate_method(&method)?;
    let params = match params {
        None | Some(Value::Null) => json!({}),
        Some(v @ Value::Object(_)) => v,
        Some(_) => return Err(WorkerError::invalid("params must be a JSON object")),
    };
    state.supervisor.request(id, &method, params).await
}

/// Best-effort cancel of an in-flight request. Returns false when nothing is pending under `id`.
#[tauri::command]
pub async fn worker_cancel(state: State<'_, ShellState>, id: String) -> Result<bool, WorkerError> {
    let id = validate_uuid(&id)?;
    state.supervisor.cancel(&id).await
}

/// Supervisor snapshot (same shape as the `worker://status` event payload).
#[tauri::command]
pub fn worker_status(state: State<'_, ShellState>) -> WorkerStatus {
    state.supervisor.status()
}

/// Kill and respawn the worker immediately; also leaves the `stopped` state.
#[tauri::command]
pub fn worker_restart(state: State<'_, ShellState>) -> WorkerStatus {
    state.supervisor.restart();
    state.supervisor.status()
}

// ---------------------------------------------------------------- paths / runtime

/// The app directories (absolute).
#[tauri::command]
pub fn app_paths(state: State<'_, ShellState>) -> AppPaths {
    state.paths.clone()
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeStatus {
    pub python: String,
    pub pythonpath: String,
    pub mode: String,
    pub found: bool,
    pub python_found: bool,
    pub package_found: bool,
    pub source: String,
    pub runtime_root: String,
    pub bootstrap_script: String,
    pub bootstrap_script_found: bool,
    pub bootstrap_running: bool,
    pub standalone: bool,
}

impl RuntimeStatus {
    fn build(state: &ShellState, loc: WorkerLocation) -> Self {
        let script = state.paths.scripts_dir().join("bootstrap.sh");
        Self {
            python: loc.python.display().to_string(),
            pythonpath: loc.pythonpath.display().to_string(),
            mode: loc.mode.to_string(),
            found: loc.found,
            python_found: loc.python_found,
            package_found: loc.package_found,
            source: loc.source.to_string(),
            runtime_root: state.paths.runtime_root.display().to_string(),
            bootstrap_script_found: script.is_file(),
            bootstrap_script: script.display().to_string(),
            bootstrap_running: state.bootstrap_running.load(Ordering::SeqCst),
            standalone: loc.standalone,
        }
    }
}

/// Where the worker python is (or would be) and whether the bootstrap is running.
#[tauri::command]
pub fn runtime_status(state: State<'_, ShellState>) -> RuntimeStatus {
    RuntimeStatus::build(&state, locate_worker(&state.paths))
}

/// Resets the bootstrap flag when the command future ends, however it ends.
struct BootstrapGuard<'a>(&'a AtomicBool);

impl Drop for BootstrapGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Run `scripts/bootstrap.sh --runtime-dir <data>/runtime`, streaming every output line as a
/// `runtime://log` event. Returns `Ok(0)` and restarts the worker on success; any other exit
/// code (-1 when killed by a signal) is an `INTERNAL` error with `details.exit_code`.
/// Refused with `BUSY` while a bootstrap is already running.
///
/// `with_chatterbox` adds `--with-chatterbox` / `--without-chatterbox` (script default when
/// omitted); `auto_install_uv` sets `SFVS_AUTO_INSTALL_UV=1` so the script may fetch `uv`.
#[tauri::command]
pub async fn runtime_bootstrap(
    app: AppHandle,
    state: State<'_, ShellState>,
    with_chatterbox: Option<bool>,
    auto_install_uv: Option<bool>,
) -> Result<i32, WorkerError> {
    if state.bootstrap_running.swap(true, Ordering::SeqCst) {
        return Err(WorkerError::new(
            codes::BUSY,
            "The runtime bootstrap is already running.",
        ));
    }
    let _guard = BootstrapGuard(&state.bootstrap_running);

    let script = state.paths.scripts_dir().join("bootstrap.sh");
    if !script.is_file() {
        return Err(WorkerError::not_found(format!(
            "Bootstrap script not found: {}",
            script.display()
        ))
        .unrecoverable());
    }
    let emit_line = |stream: &str, line: String| {
        let _ = app.emit(EVENT_RUNTIME_LOG, json!({ "stream": stream, "line": line }));
    };
    let mut args: Vec<String> = vec![
        "--runtime-dir".into(),
        state.paths.runtime_root.display().to_string(),
    ];
    match with_chatterbox {
        Some(true) => args.push("--with-chatterbox".into()),
        Some(false) => args.push("--without-chatterbox".into()),
        None => {}
    }
    emit_line(
        "system",
        format!("$ bash {} {}", script.display(), args.join(" ")),
    );
    let mut child = Command::new("bash")
        .arg(&script)
        .args(&args)
        .env(
            "SFVS_AUTO_INSTALL_UV",
            if auto_install_uv == Some(true) {
                "1"
            } else {
                "0"
            },
        )
        .env("SFVS_DATA_DIR", &state.paths.data)
        .env("SFVS_BACKEND_DIR", state.paths.backend_dir())
        .env("PYTHONUNBUFFERED", "1")
        .current_dir(script.parent().unwrap_or(Path::new("/")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| WorkerError::internal(format!("Cannot start the bootstrap: {e}")))?;

    let out_task = pump_lines(app.clone(), "stdout", child.stdout.take());
    let err_task = pump_lines(app.clone(), "stderr", child.stderr.take());
    let status = child
        .wait()
        .await
        .map_err(|e| WorkerError::internal(format!("Waiting for the bootstrap failed: {e}")))?;
    let _ = out_task.await;
    let _ = err_task.await;
    let code = status.code().unwrap_or(-1);
    emit_line("system", format!("bootstrap exited with code {code}"));
    info!("runtime bootstrap finished with code {code}");
    if code != 0 {
        return Err(WorkerError::new(
            codes::INTERNAL,
            format!("The runtime bootstrap exited with code {code}; see the log above."),
        )
        .with_details(json!({ "exit_code": code })));
    }
    state.supervisor.restart();
    Ok(code)
}

/// Forward every line of `pipe` as a `runtime://log` event.
fn pump_lines<P>(
    app: AppHandle,
    stream: &'static str,
    pipe: Option<P>,
) -> tauri::async_runtime::JoinHandle<()>
where
    P: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let Some(pipe) = pipe else { return };
        let mut lines = BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app.emit(EVENT_RUNTIME_LOG, json!({ "stream": stream, "line": line }));
        }
    })
}

// ---------------------------------------------------------------- dialogs

/// Native multi-select dialog for wav/mp3/flac files. Empty when cancelled.
#[tauri::command]
pub async fn pick_audio_files(
    app: AppHandle,
    state: State<'_, ShellState>,
) -> Result<Vec<String>, WorkerError> {
    let picked = app
        .dialog()
        .file()
        .set_title("Choose audio files")
        .add_filter("Audio", &["wav", "mp3", "flac"])
        .blocking_pick_files()
        .unwrap_or_default();
    let mut out = Vec::new();
    for fp in picked {
        if let Ok(p) = fp.into_path() {
            state.remember_file(&state.picked_files, &p);
            out.push(p.display().to_string());
        }
    }
    Ok(out)
}

/// Native dialog for a text/markdown file; the picked path becomes readable via `read_text_file`.
#[tauri::command]
pub async fn pick_text_file(
    app: AppHandle,
    state: State<'_, ShellState>,
) -> Result<Option<String>, WorkerError> {
    let picked = app
        .dialog()
        .file()
        .set_title("Choose a script file")
        .add_filter("Text", &["txt", "md", "text"])
        .blocking_pick_file();
    Ok(picked.and_then(|fp| fp.into_path().ok()).map(|p| {
        state.remember_file(&state.text_files, &p);
        p.display().to_string()
    }))
}

/// Native save dialog. Ensures the `.ext` suffix; the chosen file and its folder become
/// openable via `open_path`/`reveal_path`. `None` when cancelled.
#[tauri::command]
pub async fn pick_save_path(
    app: AppHandle,
    state: State<'_, ShellState>,
    default_name: String,
    ext: String,
) -> Result<Option<String>, WorkerError> {
    let ext: String = ext
        .trim_start_matches('.')
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase();
    if ext.is_empty() {
        return Err(WorkerError::invalid(
            "ext must be a file extension like \"wav\"",
        ));
    }
    let name = sanitize_file_name(&default_name, &ext);
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save as")
        .add_filter(ext.to_uppercase(), &[ext.as_str()])
        .set_file_name(name);
    let exports = state.paths.data.join("exports");
    if exports.is_dir() {
        dialog = dialog.set_directory(&exports);
    }
    let Some(picked) = dialog
        .blocking_save_file()
        .and_then(|fp| fp.into_path().ok())
    else {
        return Ok(None);
    };
    let picked = if picked.extension().and_then(|e| e.to_str()) == Some(ext.as_str()) {
        picked
    } else {
        let mut s = picked.into_os_string();
        s.push(format!(".{ext}"));
        PathBuf::from(s)
    };
    if let Some(parent) = picked.parent() {
        state.allow_dir(parent);
    }
    state.remember_file(&state.picked_files, &picked);
    Ok(Some(picked.display().to_string()))
}

/// Native dialog for a project backup zip; the picked path becomes openable. `None` when cancelled.
#[tauri::command]
pub async fn pick_archive_file(
    app: AppHandle,
    state: State<'_, ShellState>,
) -> Result<Option<String>, WorkerError> {
    let picked = app
        .dialog()
        .file()
        .set_title("Choose a backup zip")
        .add_filter("Backup zip", &["zip"])
        .blocking_pick_file();
    Ok(picked.and_then(|fp| fp.into_path().ok()).map(|p| {
        state.remember_file(&state.picked_files, &p);
        p.display().to_string()
    }))
}

/// Native folder picker; the folder becomes openable. `None` when cancelled.
#[tauri::command]
pub async fn pick_directory(
    app: AppHandle,
    state: State<'_, ShellState>,
) -> Result<Option<String>, WorkerError> {
    let picked = app
        .dialog()
        .file()
        .set_title("Choose a folder")
        .blocking_pick_folder();
    Ok(picked.and_then(|fp| fp.into_path().ok()).map(|p| {
        state.allow_dir(&p);
        p.display().to_string()
    }))
}

fn sanitize_file_name(name: &str, ext: &str) -> String {
    let mut base: String = name
        .chars()
        .map(|c| {
            if c.is_control() || c == '/' || c == '\\' {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .trim_start_matches('.')
        .chars()
        .take(120)
        .collect();
    if base.is_empty() {
        base = "untitled".into();
    }
    if Path::new(&base).extension().and_then(|e| e.to_str()) == Some(ext) {
        base
    } else {
        format!("{base}.{ext}")
    }
}

// ---------------------------------------------------------------- files

/// Read a text file the user picked with `pick_text_file` this session (<= 5 MB).
#[tauri::command]
pub async fn read_text_file(
    state: State<'_, ShellState>,
    path: String,
) -> Result<String, WorkerError> {
    let p = absolute(&path)?;
    let canon = p
        .canonicalize()
        .map_err(|e| WorkerError::not_found(format!("Cannot read {}: {e}", p.display())))?;
    if !state.text_files.lock().unwrap().contains(&canon) {
        return Err(WorkerError::denied(
            "Only files picked through the file dialog in this session can be read.",
        ));
    }
    let meta = tokio::fs::metadata(&canon).await?;
    if !meta.is_file() {
        return Err(WorkerError::invalid("Not a regular file."));
    }
    if meta.len() > MAX_TEXT_FILE_BYTES {
        return Err(WorkerError::invalid(format!(
            "The file is {} MB; the limit is 5 MB.",
            meta.len() / (1024 * 1024)
        ))
        .with_details(json!({ "size_bytes": meta.len(), "limit_bytes": MAX_TEXT_FILE_BYTES })));
    }
    let bytes = tokio::fs::read(&canon).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn check_openable(state: &ShellState, path: &str) -> Result<PathBuf, WorkerError> {
    let p = absolute(path)?;
    if !state.may_open(&p) {
        return Err(WorkerError::denied(
            "Only paths inside the app folders or picked in this session can be opened.",
        ));
    }
    if !p.exists() {
        return Err(WorkerError::not_found(format!(
            "{} does not exist.",
            p.display()
        )));
    }
    Ok(p)
}

/// Open a file or folder with the desktop's default handler.
#[tauri::command]
pub fn open_path(
    app: AppHandle,
    state: State<'_, ShellState>,
    path: String,
) -> Result<(), WorkerError> {
    let p = check_openable(&state, &path)?;
    app.opener()
        .open_path(p.display().to_string(), None::<&str>)
        .map_err(|e| WorkerError::internal(format!("Cannot open {}: {e}", p.display())))
}

/// Open the folder that contains `path` in the file manager.
#[tauri::command]
pub fn reveal_path(
    app: AppHandle,
    state: State<'_, ShellState>,
    path: String,
) -> Result<(), WorkerError> {
    let p = check_openable(&state, &path)?;
    let parent = p
        .parent()
        .ok_or_else(|| WorkerError::invalid("The path has no parent folder."))?;
    app.opener()
        .open_path(parent.display().to_string(), None::<&str>)
        .map_err(|e| WorkerError::internal(format!("Cannot open {}: {e}", parent.display())))
}

// ---------------------------------------------------------------- window

/// Set the main window title (control characters stripped, 200 chars max).
#[tauri::command]
pub fn set_window_title(app: AppHandle, title: String) -> Result<(), WorkerError> {
    let clean: String = title
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_TITLE_CHARS)
        .collect();
    let title = if clean.trim().is_empty() {
        "Shadowfetch Voice Studio".to_string()
    } else {
        clean
    };
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| WorkerError::not_found("main window not found"))?;
    window.set_title(&title).map_err(|e| {
        warn!("set_title failed: {e}");
        WorkerError::internal(e.to_string())
    })
}
