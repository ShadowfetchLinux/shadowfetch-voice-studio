# Shadowfetch Voice Studio — desktop shell (Tauri 2)

Rust shell around the Python worker. It supervises the worker process, forwards its
progress/events to the webview, owns the native dialogs and enforces least privilege:
the UI cannot run commands or read arbitrary files.

```
src/lib.rs        Tauri builder, plugins (log, dialog, opener), setup, exit hook
src/worker.rs     Supervisor: spawn / JSON-lines protocol / health / restart / shutdown
src/commands.rs   #[tauri::command]s (the only surface the webview can call)
src/paths.rs      app directories + locating the worker interpreter (dev vs managed)
src/error.rs      WorkerError {code, message, details, recoverable} – same shape as PROTOCOL.md
capabilities/     least-privilege capability for the `main` window (no shell/fs/http plugins)
linux/*.desktop.hbs  desktop-entry template used by the deb/AppImage bundler
tests/supervisor-harness/  cargo tests for the Tauri-free modules (run without WebKitGTK)
```

## Supervisor (`src/worker.rs`)

1. Locates the interpreter (see *Environment*) and spawns
   `python -m shadowfetch_worker --data-dir … --config-dir … --cache-dir …` with stdin/stdout
   piped. stderr is appended to `<data>/logs/shell-worker.log` (rotated once past 20 MB).
2. Waits up to 60 s for the `{"type":"ready"}` line, then marks the worker `running` and emits
   `worker://status`.
3. Requests: `worker_request` writes `{"v":1,"type":"request",...}` and parks a oneshot in the
   pending map keyed by the request id. `result`/`error` lines resolve it; `progress` lines are
   emitted as `worker://progress` (`{id, stage, message, current?, total?, detail?}`), `event`
   lines as `worker://event` (`{event, data}`).
4. Health: `system.ping` every 20 s with a 10 s timeout. A timeout only restarts the worker when
   it has been completely silent meanwhile — a busy worker that is still streaming progress is
   left alone.
5. Exit (crash, kill, health failure): every pending request fails with `WORKER_DOWN`,
   `worker://status` is emitted with `running:false` and `last_error`, and the worker is
   respawned with backoff 1 s, 2 s, 4 s … (max 30 s). More than 5 restarts within 2 minutes →
   the supervisor gives up: `stopped:true` until `worker_restart` (or a successful
   `runtime_bootstrap`) is called. A manual restart resets the crash budget.
6. App exit: `{"type":"shutdown"}` is written, the child gets 3 s to leave, then it is killed.

`worker://status` payload / `worker_status()` result:
`{running, stopped, pid, restarts, last_error, started_at_unix_ms, pending, python, pythonpath, mode, python_found}`.

## Commands

Invoke with `@tauri-apps/api/core` (`invoke("worker_request", { id, method, params })`);
argument names are camelCase on the JS side (`defaultName`, `withChatterbox`, …). Errors are
`WorkerError` objects; shell-specific codes are `WORKER_DOWN` and `BUSY`, everything else comes
from the worker unchanged.

| command | args → result |
|---------|---------------|
| `worker_request` | `{id?: uuid, method, params?}` → worker result |
| `worker_cancel` | `{id}` → `bool` (false when nothing is pending under that id) |
| `worker_status` / `worker_restart` | → status snapshot |
| `app_paths` | → `{data, config, cache, resource, runtime_root}` |
| `runtime_status` | → `{python, pythonpath, mode, found, python_found, package_found, source, runtime_root, bootstrap_script, bootstrap_script_found, bootstrap_running}` |
| `runtime_bootstrap` | `{withChatterbox?, autoInstallUv?}` → exit code; streams `runtime://log` `{stream, line}`; `BUSY` while running |
| `pick_audio_files` | → `string[]` (wav/mp3/flac, multi-select) |
| `pick_text_file` | → `string \| null`; only these paths may be read with `read_text_file` |
| `pick_save_path` | `{defaultName, ext}` → `string \| null` (extension enforced) |
| `pick_directory` | → `string \| null` |
| `read_text_file` | `{path}` → text (≤ 5 MB, must have been picked this session) |
| `open_path` / `reveal_path` | `{path}`; allowed under data/config/cache or dirs/files picked this session; `reveal_path` opens the parent folder |
| `set_window_title` | `{title}` |

## Environment

| variable | effect |
|----------|--------|
| `SFVS_WORKER_PYTHON` | interpreter to use for the worker (first choice) |
| `SFVS_BACKEND_DIR` | directory holding the `shadowfetch_worker` package (PYTHONPATH) |
| `SFVS_RUNTIME_DIR` | managed runtime root (default `<data>/runtime`); passed to the worker |
| `XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` | relocate the app dirs (Tauri + worker agree) |

Interpreter lookup order: `SFVS_WORKER_PYTHON` → (debug build) `backend/.venv/bin/python` →
`<runtime>/envs/main/bin/python`. `PYTHONPATH` is the checkout's `backend/` in debug builds
(mode `dev`) and `<resource_dir>/backend` in release builds (mode `managed`).

Directories (Linux): `~/.local/share/com.shadowfetch.voicestudio` (data),
`~/.config/com.shadowfetch.voicestudio` (config), `~/.cache/com.shadowfetch.voicestudio` (cache).
The asset protocol scope (`$APPDATA/**`, `$APPCACHE/**`, `$APPCONFIG/**`) is keyed to the same
directories, which is why the worker is handed exactly these paths.

Logs: `<data>/logs/shell.log` (this crate, via tauri-plugin-log), `<data>/logs/shell-worker.log`
(worker stderr), `<data>/logs/worker.log` (the worker's own, redacted).

## Building

System packages (Pop!_OS / Ubuntu 24.04): `libwebkit2gtk-4.1-dev libgtk-3-dev libdbus-1-dev
libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev patchelf pkg-config build-essential`.

```
cd src-tauri && cargo check                    # needs the -dev packages above
npx @tauri-apps/cli@latest dev                 # runs `npm run dev` in ../frontend first
npx @tauri-apps/cli@latest build --bundles deb,appimage
cargo test --manifest-path tests/supervisor-harness/Cargo.toml --lib --tests   # no GTK needed
```

The bundle ships `backend/shadowfetch_worker`, `backend/requirements`, `backend/runtime.json`,
`scripts/` and `docs/*.md` under `/usr/lib/Shadowfetch Voice Studio/`; `scripts/bootstrap.sh
--runtime-dir <data>/runtime` builds the managed Python environments on first run. Clean
`__pycache__` before bundling — the bundler copies whole directories.
