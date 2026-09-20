// Prevents an additional console window on Windows in release; harmless on Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's GStreamer media player only accepts blob/data/file/http/https URLs plus the schemes
    // listed in this variable (WebCore GStreamerCommon.cpp `isProtocolAllowed`). Tauri serves local
    // recordings and takes through its `asset://` protocol, so <audio> playback fails with a
    // FormatError unless the scheme is allowed. Must be set before the web process is spawned.
    #[cfg(target_os = "linux")]
    {
        let key = "WEBKIT_GST_ALLOWED_URI_PROTOCOLS";
        let mut value = std::env::var(key).unwrap_or_default();
        if !value.split(',').any(|p| p.trim().eq_ignore_ascii_case("asset")) {
            if !value.is_empty() {
                value.push(',');
            }
            value.push_str("asset");
            std::env::set_var(key, value);
        }
    }
    shadowfetch_voice_studio_lib::run()
}
