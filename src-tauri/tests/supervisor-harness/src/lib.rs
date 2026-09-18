//! Compiles the shell's Tauri-free modules in isolation (see Cargo.toml).
#[path = "../../../src/error.rs"]
pub mod error;
#[path = "../../../src/paths.rs"]
pub mod paths;
#[path = "../../../src/worker.rs"]
pub mod worker;
