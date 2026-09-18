// Prevents an additional console window on Windows in release; harmless on Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    shadowfetch_voice_studio_lib::run()
}
