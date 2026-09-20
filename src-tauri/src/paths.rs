//! Where things live: app directories, the packaged resources and the worker's Python.
//!
//! This module is deliberately free of Tauri types so it can be unit-tested on its own;
//! `lib.rs` feeds it the directories resolved by `tauri::path::PathResolver`.

use std::env;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// Environment variable that pins the worker interpreter (dev or troubleshooting).
pub const ENV_WORKER_PYTHON: &str = "SFVS_WORKER_PYTHON";
/// Environment variable that relocates the managed runtime (mirrors `runtime.py`).
pub const ENV_RUNTIME_DIR: &str = "SFVS_RUNTIME_DIR";
/// Environment variable that points at a `backend/` directory (the one holding the
/// `shadowfetch_worker` package) instead of the checkout / packaged copy.
pub const ENV_BACKEND_DIR: &str = "SFVS_BACKEND_DIR";

/// The application directories (all absolute).
///
/// On Linux `data`/`config`/`cache` are Tauri's per-identifier XDG dirs, e.g.
/// `~/.local/share/com.shadowfetch.voicestudio`; the asset protocol scope
/// (`$APPDATA/**` …) is keyed to the same directories.
#[derive(Debug, Clone, Serialize)]
pub struct AppPaths {
    pub data: PathBuf,
    pub config: PathBuf,
    pub cache: PathBuf,
    /// Packaged resources (`/usr/lib/<product>` in the .deb, `$APPDIR/usr/lib/<product>` in the
    /// AppImage, the cargo target dir in development).
    pub resource: PathBuf,
    /// Managed Python environments: `<data>/runtime` unless `SFVS_RUNTIME_DIR` overrides it.
    pub runtime_root: PathBuf,
}

impl AppPaths {
    /// Build the layout from the directories the platform resolved.
    pub fn new(data: PathBuf, config: PathBuf, cache: PathBuf, resource: PathBuf) -> Self {
        let runtime_root = env::var_os(ENV_RUNTIME_DIR)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| data.join("runtime"));
        Self {
            data,
            config,
            cache,
            resource,
            runtime_root,
        }
    }

    /// Create the directories the shell itself writes to (the worker creates the rest).
    pub fn ensure(&self) -> std::io::Result<()> {
        for d in [
            &self.data,
            &self.config,
            &self.cache,
            &self.logs(),
            &self.runtime_root,
        ] {
            std::fs::create_dir_all(d)?;
        }
        Ok(())
    }

    /// `<data>/logs` – shared with the worker (`worker.log`) and the log plugin (`shell.log`).
    pub fn logs(&self) -> PathBuf {
        self.data.join("logs")
    }

    /// Where the worker's stderr is appended.
    pub fn worker_stderr_log(&self) -> PathBuf {
        self.logs().join("shell-worker.log")
    }

    /// `SFVS_BACKEND_DIR` if set, else the checkout's `backend/` in debug builds, else the
    /// packaged copy.
    pub fn backend_dir(&self) -> PathBuf {
        if let Some(p) = env::var_os(ENV_BACKEND_DIR)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
        {
            p
        } else if cfg!(debug_assertions) {
            dev_checkout_dir().join("backend")
        } else {
            self.resource.join("backend")
        }
    }

    /// The checkout's `scripts/` in debug builds, the packaged copy otherwise.
    pub fn scripts_dir(&self) -> PathBuf {
        if cfg!(debug_assertions) {
            dev_checkout_dir().join("scripts")
        } else {
            self.resource.join("scripts")
        }
    }

    /// Roots the UI may open/reveal without having picked them through a dialog.
    pub fn managed_roots(&self) -> Vec<PathBuf> {
        vec![self.data.clone(), self.config.clone(), self.cache.clone()]
    }
}

/// The repository root when running a debug build (`CARGO_MANIFEST_DIR/..`).
fn dev_checkout_dir() -> PathBuf {
    normalize(&Path::new(env!("CARGO_MANIFEST_DIR")).join(".."))
}

/// Lexically collapse `.` and `..` (no filesystem access, unlike `canonicalize`).
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// How the worker interpreter was located.
#[derive(Debug, Clone, Serialize)]
pub struct WorkerLocation {
    /// The interpreter to run `python -m shadowfetch_worker` with.
    pub python: PathBuf,
    /// Directory containing the `shadowfetch_worker` package.
    pub pythonpath: PathBuf,
    /// `"dev"` (debug build, checkout backend) or `"managed"` (packaged runtime env).
    pub mode: &'static str,
    /// Which rule produced `python`: `"env"`, `"dev-venv"` or `"managed"`.
    pub source: &'static str,
    /// True when both the interpreter and the worker package exist.
    pub found: bool,
    pub python_found: bool,
    pub package_found: bool,
    /// True when the chosen interpreter is not a symlink into another tree
    /// (a leftover `runtime/envs/main → <checkout>/.venv` is not standalone).
    pub standalone: bool,
}

/// Locate the worker python: `SFVS_WORKER_PYTHON` → (debug build) `backend/.venv/bin/python`
/// → `<runtime_root>/envs/main/bin/python`. The first candidate that exists wins; when none
/// exists the report points at the env override if set, else at the managed path bootstrap
/// would create.
pub fn locate_worker(paths: &AppPaths) -> WorkerLocation {
    let pythonpath = paths.backend_dir();
    let mode = if cfg!(debug_assertions) {
        "dev"
    } else {
        "managed"
    };
    let managed = paths.runtime_root.join("envs/main/bin/python");
    let env_override = env::var_os(ENV_WORKER_PYTHON)
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty());

    let mut candidates: Vec<(&'static str, PathBuf)> = Vec::new();
    if let Some(p) = &env_override {
        candidates.push(("env", p.clone()));
    }
    if cfg!(debug_assertions) {
        candidates.push((
            "dev-venv",
            dev_checkout_dir().join("backend/.venv/bin/python"),
        ));
    }
    candidates.push(("managed", managed.clone()));

    let (source, python, python_found) = match candidates
        .iter()
        .find(|(src, p)| p.is_file() && candidate_usable(src, p, &paths.runtime_root))
    {
        Some((src, p)) => (*src, p.clone(), true),
        None => match env_override {
            Some(p) => ("env", p, false),
            None => ("managed", managed, false),
        },
    };
    let package_found = pythonpath.join("shadowfetch_worker/__main__.py").is_file();
    let standalone = python_found && interpreter_is_standalone(&python, &paths.runtime_root, source);
    WorkerLocation {
        python,
        pythonpath,
        mode,
        source,
        found: python_found && package_found,
        python_found,
        package_found,
        standalone,
    }
}

/// `runtime/envs/main` must be a real directory (or a symlink that still
/// resolves inside `runtime_root`). A link into the git checkout is how the
/// packaged app used to depend on `~/Projects/shadowfetch-voice-studio`.
pub fn env_is_standalone(env_dir: &Path, runtime_root: &Path) -> bool {
    let Ok(meta) = env_dir.symlink_metadata() else {
        return false;
    };
    if !meta.file_type().is_symlink() {
        return env_dir.is_dir();
    }
    let Ok(target) = env_dir.canonicalize() else {
        return false;
    };
    let root = runtime_root
        .canonicalize()
        .unwrap_or_else(|_| runtime_root.to_path_buf());
    target.starts_with(&root)
}

fn env_dir_of_python(python: &Path) -> Option<&Path> {
    python.parent().and_then(Path::parent)
}

fn candidate_usable(source: &str, python: &Path, runtime_root: &Path) -> bool {
    if source != "managed" {
        return true;
    }
    env_dir_of_python(python).is_some_and(|dir| env_is_standalone(dir, runtime_root))
}

fn interpreter_is_standalone(python: &Path, runtime_root: &Path, source: &str) -> bool {
    match source {
        "env" => true,
        "managed" => env_dir_of_python(python).is_some_and(|dir| env_is_standalone(dir, runtime_root)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_collapses_dots() {
        assert_eq!(
            normalize(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
        assert_eq!(normalize(Path::new("/a/../..")), PathBuf::from("/.."));
    }

    #[test]
    fn runtime_root_defaults_under_data() {
        let p = AppPaths::new("/d".into(), "/c".into(), "/k".into(), "/r".into());
        if env::var_os(ENV_RUNTIME_DIR).is_none() {
            assert_eq!(p.runtime_root, PathBuf::from("/d/runtime"));
        }
        assert_eq!(
            p.worker_stderr_log(),
            PathBuf::from("/d/logs/shell-worker.log")
        );
    }

    #[test]
    fn checkout_symlink_is_not_standalone() {
        let tmp = std::env::temp_dir().join(format!(
            "sfvs-paths-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let runtime = tmp.join("runtime");
        let checkout = tmp.join("checkout/.venv");
        std::fs::create_dir_all(runtime.join("envs")).unwrap();
        std::fs::create_dir_all(&checkout).unwrap();
        let linked = runtime.join("envs/main");
        std::os::unix::fs::symlink(&checkout, &linked).unwrap();
        assert!(!env_is_standalone(&linked, &runtime));

        std::fs::remove_file(&linked).unwrap();
        std::fs::create_dir_all(&linked).unwrap();
        assert!(env_is_standalone(&linked, &runtime));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
