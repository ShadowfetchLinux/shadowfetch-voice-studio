# Shadowfetch Voice Studio

A private, local-only voice cloning studio for Linux. Record or import a clean reference clip, review the
waveform and transcript, save a reusable voice profile, then turn any script into speech with that voice —
entirely on your own machine.

- **Engines:** Qwen3-TTS 1.7B Base (primary, reference-audio cloning) and Chatterbox-Turbo (optional).
- **Transcription:** faster-whisper, CPU by default.
- **Shell:** Tauri 2 (Rust) + React/TypeScript; Python workers for audio and inference; FFmpeg for
  media handling; SQLite for metadata.
- **Privacy:** no telemetry, no cloud inference. The only network use is downloading model weights you
  approve; *Offline mode* blocks every request.

> Status: v0.1.0 — see `docs/TEST_REPORT.md` for what has actually been verified on real hardware.

## Requirements (Pop!_OS 24.04 / Ubuntu 24.04)

| Component | How it is provided |
|-----------|-------------------|
| NVIDIA driver ≥ 570 (CUDA 12.8 capable) | your existing driver (no CUDA toolkit needed) |
| `ffmpeg`, `libportaudio2` | system packages (`sudo apt install ffmpeg libportaudio2`) |
| Python 3.12 runtime for the workers | created by `scripts/bootstrap.sh` with `uv` (no sudo; ~9 GB with the CUDA stack) |
| Model weights | downloaded by the app after showing size and license (Qwen ≈ 4.5 GB, whisper ≈ 0.5 GB, Chatterbox ≈ 3 GB optional) |
| For building from source | Rust toolchain, Node 22, and `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf` |

## Quick start (from source)

```bash
scripts/doctor.sh        # what is installed / missing, GPU + CUDA check
scripts/bootstrap.sh     # isolated Python environments (asks before optional Chatterbox)
scripts/dev.sh           # launches the desktop app in development mode
scripts/test.sh          # unit tests (add --real for GPU/model integration tests)
scripts/build.sh         # .deb (+ AppImage) into src-tauri/target/release/bundle/
```

Installing the `.deb` puts the app in your application menu. On first launch the guided setup checks
FFmpeg, GPU, audio devices, storage and models, and offers to create the Python runtime under
`~/.local/share/com.shadowfetch.voicestudio/runtime`.

## Workflow

1. **Voices** — record with the microphone (guided reading scripts, live meter, 24-bit WAV) or import
   WAV/MP3/FLAC → trim a 10–15 s reference → transcribe locally → correct the transcript → confirm rights
   → save the voice profile (audio + transcript are the source of truth; engine prompts are caches).
2. **Create** — write or import a script, pick a voice and engine, generate a preview or the full script
   (segment by segment, measured progress), regenerate single segments, compare takes, assemble.
3. **Library** — search, tag, favorite, duplicate, archive; export WAV/FLAC/MP3 with optional named
   loudness targets and AI-generated metadata; backup/restore projects as portable zips.

## Where data lives

| | |
|-|-|
| projects, recordings, voices, masters, SQLite DB | `~/.local/share/com.shadowfetch.voicestudio/` |
| settings | `~/.config/com.shadowfetch.voicestudio/settings.json` |
| regenerable caches (peaks, engine prompts) | `~/.cache/com.shadowfetch.voicestudio/` |
| models (Hugging Face cache layout) | `~/.local/share/com.shadowfetch.voicestudio/models/hf/` |

Local storage is **not** encrypted; treat the data directory like any other private files.

## Documentation

`docs/ARCHITECTURE.md` · `docs/PROTOCOL.md` · `docs/MODEL_LICENSES.md` · `docs/THIRD_PARTY_NOTICES.md` ·
`docs/TEST_REPORT.md` · `docs/USER_GUIDE.md`
