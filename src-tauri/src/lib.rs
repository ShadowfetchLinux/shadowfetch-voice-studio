//! Shadowfetch Voice Studio desktop shell (Tauri 2).
//!
//! The shell does three things: supervises the Python worker (`worker.rs`), exposes a small
//! set of typed commands to the webview (`commands.rs`) and owns the native dialogs. It
//! never runs shell commands on behalf of the UI and never reads arbitrary files.

mod commands;
mod error;
mod paths;
mod worker;

use std::sync::Arc;

use log::{error, info, LevelFilter};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

use commands::ShellState;
use paths::AppPaths;
use worker::{EventSink, Supervisor};

impl EventSink for AppHandle {
    fn emit(&self, event: &str, payload: Value) {
        if let Err(e) = Emitter::emit(self, event, payload) {
            error!("emit {event} failed: {e}");
        }
    }
}

/// Resolve the app directories from Tauri's path resolver.
fn resolve_paths(app: &AppHandle) -> tauri::Result<AppPaths> {
    let p = app.path();
    Ok(AppPaths::new(
        p.app_data_dir()?,
        p.app_config_dir()?,
        p.app_cache_dir()?,
        p.resource_dir()?,
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let log_level = if cfg!(debug_assertions) {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log_level)
                .level_for("hyper", LevelFilter::Warn)
                .level_for("tao", LevelFilter::Warn)
                .clear_targets()
                .targets([
                    Target::new(TargetKind::Stderr),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("shell".into()),
                    }),
                ])
                .max_file_size(5_000_000)
                .rotation_strategy(RotationStrategy::KeepOne)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let paths = resolve_paths(&handle)?;
            paths.ensure()?;
            info!(
                "data={} config={} cache={} resource={} runtime={}",
                paths.data.display(),
                paths.config.display(),
                paths.cache.display(),
                paths.resource.display(),
                paths.runtime_root.display()
            );
            let sink: Arc<dyn EventSink> = Arc::new(handle.clone());
            let tokio_handle = tauri::async_runtime::handle().inner().clone();
            let supervisor = Arc::new(Supervisor::new(sink, tokio_handle, paths.clone()));
            supervisor.start();
            app.manage(ShellState::new(paths, supervisor));
            // Wayland/COSMIC looks up the window icon by GTK app id; also stamp the
            // bundled waveform onto the window so the title bar is never empty.
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon().cloned() {
                    if let Err(e) = window.set_icon(icon) {
                        log::warn!("could not set the window icon: {e}");
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::worker_request,
            commands::worker_cancel,
            commands::worker_status,
            commands::worker_restart,
            commands::app_paths,
            commands::runtime_status,
            commands::runtime_bootstrap,
            commands::pick_audio_files,
            commands::pick_text_file,
            commands::pick_save_path,
            commands::pick_archive_file,
            commands::pick_directory,
            commands::read_text_file,
            commands::open_path,
            commands::reveal_path,
            commands::set_window_title,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Tauri application");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            info!("app exiting; shutting the worker down");
            let supervisor = app.state::<ShellState>().supervisor.clone();
            tauri::async_runtime::block_on(supervisor.shutdown());
        }
    });
}
