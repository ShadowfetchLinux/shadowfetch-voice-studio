# Shadowfetch Voice Studio

<img src="src-tauri/icons/128x128.png" alt="Shadowfetch Voice Studio icon" width="96" height="96">

A private, local-only voice cloning studio for Linux. Record or import a clean reference clip, review the
waveform and transcript, save a reusable voice, then turn a script into speech — entirely on your own machine.

- **Engines:** Qwen3-TTS 1.7B Base (primary, reference-audio cloning) and optional Chatterbox-Turbo.
- **Transcription:** faster-whisper, CPU by default.
- **Shell:** Tauri 2 (Rust) + React/TypeScript; Python workers for audio and inference; FFmpeg for media; SQLite for metadata.
- **Privacy:** no telemetry and no cloud inference. The only network use is downloading model weights you approve. **Offline mode** blocks every request.

Status: v0.1.1 standalone Linux desktop app. See [docs/TEST_REPORT.md](docs/TEST_REPORT.md) for what has been verified on Linux with an NVIDIA GPU.

## Requirements

Aimed at **Pop!_OS / Ubuntu 24.04-class** desktops with an NVIDIA GPU.

| Component | Notes |
|-----------|--------|
| NVIDIA driver (CUDA 12.8 capable, driver ≥ 570) | Use the driver already on the system. No CUDA toolkit install is required. |
| `ffmpeg`, `libportaudio2` | `sudo apt install ffmpeg libportaudio2` |
| Python 3.12 for the engine runtime | Created by first-run setup or `scripts/bootstrap.sh` with `uv` (no sudo; several GB for the CUDA stack) |
| Model weights | Downloaded in-app after size and license are shown (Qwen ≈ 4.5 GB, whisper ≈ 0.5 GB, Chatterbox ≈ 3 GB optional) |
| Building from source | Rust, Node 22, and `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf` |

## Install

### From a `.deb`

Build a package with `scripts/build.sh` (or `scripts/build.sh --deb-only`), then:

```bash
sudo dpkg -i src-tauri/target/release/bundle/deb/*.deb
```

That installs one launcher (`com.shadowfetch.voicestudio.desktop`). The Python engine runtime is **not** inside the package; the app creates it under the data directory on first run.

### From this tree (recommended while developing)

```bash
scripts/doctor.sh          # what is installed / missing, GPU + CUDA check
scripts/bootstrap.sh       # isolated Python environments (asks before optional Chatterbox)
scripts/install-linux.sh   # build the .deb, install it, and isolate the runtime
```

`scripts/install-linux.sh` replaces the installed desktop app and writes a real venv under
`$XDG_DATA_HOME/com.shadowfetch.voicestudio/runtime` (default `~/.local/share/…/runtime`) — not a symlink back to the checkout.

Flags: `--skip-build` to reuse an existing `.deb`; `--with-chatterbox` to include the optional engine env.

### Development without installing

```bash
scripts/dev.sh             # desktop app in development mode
scripts/test.sh            # unit tests (add --real for GPU/model integration tests)
scripts/build.sh --deb-only  # supported Linux package
scripts/build.sh             # also tries an AppImage (best-effort)
```

**The `.deb` is the supported Linux install.** AppImage output is optional: `linuxdeploy` can fail (FUSE or packaging), even when `APPIMAGE_EXTRACT_AND_RUN=1` is set.

## First run

Home is three steps:

1. **New voice** — record or import a short sample, trim the best 8–15 s, transcribe locally, confirm the transcript and rights, save.
2. **Create** — write or import a script, pick the voice and engine, generate a preview or the full script, assemble.
3. **Library** — play, export (WAV/FLAC/MP3), tag, and back up projects as portable zips.

Setup checks (FFmpeg, GPU, audio devices, storage, models) are available from Home if something is missing. You can start a voice first and come back to setup when generation asks for a model or runtime.

Keyboard: `n` opens New voice; `1`–`5` switch Home / Voices / Create / Library / Settings.

## Where data lives

Paths follow XDG. If the variables are unset, the defaults below apply.

| | Default |
|-|-|
| Projects, recordings, voices, masters, SQLite, engine runtime | `$XDG_DATA_HOME/com.shadowfetch.voicestudio/` → `~/.local/share/com.shadowfetch.voicestudio/` |
| Settings | `$XDG_CONFIG_HOME/com.shadowfetch.voicestudio/settings.json` → `~/.config/com.shadowfetch.voicestudio/settings.json` |
| Regenerable caches (peaks, engine prompts) | `$XDG_CACHE_HOME/com.shadowfetch.voicestudio/` → `~/.cache/com.shadowfetch.voicestudio/` |
| Model weights (Hugging Face cache layout) | `$XDG_DATA_HOME/com.shadowfetch.voicestudio/models/hf/` |

Local storage is **not** encrypted. Treat the data directory like any other private files.

## Documentation

- [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — New Voice, Create, Library, Settings
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — process layout and data model
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — JSON-lines worker protocol
- [docs/MODEL_LICENSES.md](docs/MODEL_LICENSES.md) — engine and model licenses
- [docs/FINETUNING.md](docs/FINETUNING.md) — optional Qwen dataset export (no in-app training)
- [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md)
- [docs/TEST_REPORT.md](docs/TEST_REPORT.md)
- [docs/screenshots/](docs/screenshots/) — UI layout (browser preview mock)

License: [MIT](LICENSE).
