# Test report — v0.1.1

Machine: Pop!_OS 24.04 LTS (COSMIC, Wayland) · AMD Ryzen 7 5700G · 62 GiB RAM · NVIDIA GeForce RTX 5060 Ti 16 GB
(compute capability 12.0, driver 580.173.02) · 1.2 TB free NVMe · FFmpeg 6.1.1 · Python 3.12.3 · uv 0.11.9.
Environment: `torch 2.11.0+cu128`, `qwen-tts 0.1.1` (transformers 4.57.3), `faster-whisper 1.2.1`
(CTranslate2 4.8.2), `chatterbox-tts 0.1.7` in its own env. Models: Qwen/Qwen3-TTS-12Hz-1.7B-Base
`fd4b254389122332181a7c3db7f27e918eec64e3`, Systran/faster-whisper-small.en `d1d751a5f8271d482d14ca55d9e2deeebbae577f`,
ResembleAI/chatterbox-turbo `749d1c1a46eb10492095d68fbcf55691ccf137cd`.

Legend: **PASS** = ran on this machine · **UNIT** = automated with mocks/synthetic audio (no model or hardware) ·
**UNVERIFIED** = could not be run here; manual steps given.

## 1. Automated suites

| Suite | Command | Result |
|-------|---------|--------|
| Backend unit (mocked engines, synthetic audio) | `backend/.venv/bin/python -m pytest backend/tests -m "not realmodel"` | **169 passed, 2 skipped** |
| Backend real-model integration | `SFVS_REAL_MODELS=1 … pytest backend/tests/test_real_*.py` | **PASS** (re-run 2026-09-18: 12 passed; one Qwen load hit GPU OOM while another process held ~5 GB VRAM, then passed on retry) |
| Frontend (vitest) | `cd frontend && npm test -- --run` | **104 passed (17 files)** |
| Frontend typecheck + production build | `cd frontend && npm run build` | **PASS** |
| Rust shell | `cd src-tauri && cargo test --lib --tests --bins` | **2 passed** (linked against installed WebKitGTK). Supervisor harness: `cargo test --manifest-path src-tauri/tests/supervisor-harness/Cargo.toml` **13 passed**. `cargo test` doctests fail here because `rustdoc` cannot load `libLLVM.so` from this Rust toolchain — not an app defect. |
| Packaged `.deb` + AppImage | `scripts/build.sh` / `scripts/install-linux.sh` | **PASS** (re-run 2026-09-20) — `Shadowfetch Voice Studio_0.1.1_amd64.deb` installed over 0.1.0. One desktop file (`com.shadowfetch.voicestudio.desktop`); Hidden user stubs removed. Managed runtime is a real venv under `~/.local/share/com.shadowfetch.voicestudio/runtime` (not a checkout symlink). AppImage still fails here in `linuxdeploy` (COSMIC/FUSE); the `.deb` is the installed standalone app. |

## 2. Environment diagnostics (`scripts/doctor.sh`, `system.diagnostics`)
- GPU, driver, VRAM, utilisation, CPU, RAM, free disk, FFmpeg version, audio devices: detected live — nothing hardcoded. **PASS**
- Real CUDA smoke test: bf16 2048² matmul on the RTX 5060 Ti, sm_120 present in `torch.cuda.get_arch_list()`. **PASS**
- PortAudio (`libportaudio2`) is installed (`/lib/x86_64-linux-gnu/libportaudio.so.2`); PulseAudio-on-PipeWire 1.6.8 is the session. **PASS**

## 3. Core path (real models, through the real worker process over JSON lines) — `backend/tests/test_real_e2e.py`
Reference speech: espeak-ng (intelligible synthetic speech with a known transcript). This proves the pipeline, **not**
voice fidelity — no human recording exists on this machine (see §6 for the manual listening checklist).

| Step | Result |
|------|--------|
| Import (untouched original + one-time decode to working WAV, sha256, peaks, stats) | **PASS** |
| Trim validation (end beyond clip duration rejected) | **PASS** |
| Local transcription of the selection (faster-whisper small.en, CPU int8) | **PASS** — 92 % word overlap with the known text |
| Rights confirmation required to save a voice | **PASS** (rejected without it) |
| Save voice (fingerprint, derived engine reference, prompt cache) | **PASS** |
| Project + autosaved script + plan (3 segments over 2 paragraphs, "42" → "forty-two") | **PASS** |
| Generate all segments with Qwen3-TTS (engine host subprocess, bf16, SDPA) | **PASS** — 15.7 s of 24 kHz audio in 31.6 s; progress "Generating segment i of N" |
| Regenerate one segment; previous take kept; selection switched back | **PASS** |
| Assemble master (24-bit PCM, pauses, no overlaps) | **PASS** — whisper reads the whole script back from the master, 91 % overlap |
| Export WAV 24-bit with loudness target "podcast-16" (measured −16 ± 1 LUFS) and MP3 192 kbps; master never overwritten; AI metadata tags present | **PASS** |
| Cancel a long generation after the first segment: `CANCELLED`, finished take kept | **PASS** |
| Restart the worker, reopen the project: script, segments, takes, master all present; engines unloaded; no orphan engine processes | **PASS** |
| Offline mode: `models.download` → `OFFLINE_BLOCKED`; generation from the cached model still works (`HF_HUB_OFFLINE=1` in the engine host) | **PASS** |
| Same seed → byte-identical Qwen output; different seed → different audio (`test_real_qwen.py`) | **PASS** |
| Chatterbox-Turbo in its own environment: download through the app's model manager (progress in measured bytes, verify, s3gen.safetensors skipped), load, prepare, generate with a `[chuckle]` tag, German refused, watermark left intact (`test_real_chatterbox.py`) | **PASS** |

## 4. Failure modes
| Case | How verified | Result |
|------|--------------|--------|
| Missing model | `models.list/state`, `engine.load` → `MODEL_MISSING` with the Settings hint (unit + real) | **PASS** |
| Incomplete download (`*.incomplete` blob) reported as invalid, not installed | unit (`test_models.py`) | **UNIT** |
| Offline operation (no network requests) | real: engine host env carries `HF_HUB_OFFLINE=1`; download refused; `download_proc` exits immediately offline | **PASS** |
| Invalid files (non-audio, corrupt RIFF, header-only, PNG, missing) | unit (`test_audio.py`) | **UNIT** |
| Empty / silent input | unit: `EMPTY_AUDIO`, `MOSTLY_SILENT`/`TOO_QUIET` heuristics (`test_audio.py`) | **UNIT** |
| Low disk space | unit: `DISK_FULL` pre-checks (import, render, download); simulated `ENOSPC` while recording keeps the partial file (`test_record.py`) | **UNIT** |
| Cancellation | real (E2E) + unit (download cancel kills the subprocess) | **PASS** |
| Worker failure | engine host crash → `ENGINE_CRASHED`, host unloaded, finished takes kept (unit `test_engines_caps.py`); shell auto-restart with backoff (Rust, type-checked only) | **UNIT / UNVERIFIED (shell)** |
| Stale caches | unit: editing a transcript recomputes the fingerprint, drops derived files and prompt-cache rows (`test_store.py`) | **UNIT** |
| Simulated GPU-memory failure | unit: OOM classified as `GPU_OOM`, engine kept loaded, no retry loop (`test_engines_caps.py`) | **UNIT** |
| Microphone disconnection | unit: backend process death → `DEVICE_UNAVAILABLE` (`test_record.py`); no microphone is connected to this machine | **UNIT / UNVERIFIED (hardware)** |
| Input monitoring | unit: session feeds `MemoryMonitor` while paused; `record.start` attaches when `create_monitor` succeeds and keeps recording when it fails (`test_record.py`) | **UNIT** |
| Fine-tuned Qwen `custom_voice` | unit: capabilities/speaker control, marker prompt cache, `generate_custom_voice` without torch; `use_existing_dir` warns (`test_engines_caps.py`, `test_models.py`) | **UNIT** |
| Reference processing on derived wav | unit: stored trim/highpass/normalize applied at working rate; `prepare_reference` is not peak-normalized again (`test_store.py`) | **UNIT** |
| Multi-paragraph order + persistence across restart | real (E2E) | **PASS** |
| Exports: duration, sample rate, nonempty, finite samples | real (E2E) + unit | **PASS** |

## 5. Not verified on this machine (and how to verify)
- **Tauri window, screenshots, keyboard/layout checks at 1280×800 and 1920×1080.** Layout walked in the
  desktop UI (Home / Voices / Create / Library / Settings / Setup) at 1280×800 and Home at 1920×1080.
  Screenshots: `docs/screenshots/`. The existing packaged window on this machine could not be captured
  from the Wayland session (`xdotool` saw no X11 window); browser preview of the same React shell was used.
  Install the `.deb` and walk Voices → Create → Library at both sizes to confirm native window chrome.
- **Microphone recording with a real microphone** (no capture device is connected; only monitor sources exist).
  Manual: Voices → Record with microphone → pick the device → Record 30 s → Stop; expect a 24-bit WAV, live meter,
  and the negotiated settings panel. Then unplug the device mid-recording; expect an error state with the partial file kept.
- **Voice fidelity with an authorized human recording.** Manual listening checklist in §6.

## 6. Listening checklist (manual)
Record 30–60 s of your own voice, save a voice, generate a 3-paragraph script, assemble, and listen for:
missing words · repeated words/phrases · a voice change between segments · clipping or distortion ·
unnatural joins at sentence/paragraph boundaries · echo of the reference's last words at segment starts
(a known Qwen3-TTS behaviour; choose references that end cleanly) · speaking rate versus the reference.
Automated checks above prove intelligibility only, not naturalness.
