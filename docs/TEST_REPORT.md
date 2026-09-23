# Test report — v0.2.0 (the Speak redesign)

Verified on Linux (Ubuntu 24.04-class) with an NVIDIA GPU, FFmpeg, Python 3.12, and the app's isolated
engine environments. Exact host names, home directories, CPU/GPU SKUs, RAM, driver builds, and disk
inventory are omitted from this public report.

Software under test: `torch` 2.11 (CUDA 12.8 wheel), `qwen-tts` 0.1.1 (transformers 4.57),
`faster-whisper` 1.2, CTranslate2 4.8, optional `chatterbox-tts` 0.1.7 in its own env.

Pinned model revisions (public Hugging Face snapshots):

- Qwen/Qwen3-TTS-12Hz-1.7B-Base `fd4b254389122332181a7c3db7f27e918eec64e3`
- Systran/faster-whisper-small.en `d1d751a5f8271d482d14ca55d9e2deeebbae577f`
- ResembleAI/chatterbox-turbo `749d1c1a46eb10492095d68fbcf55691ccf137cd`

Legend: **PASS** = ran on Linux + NVIDIA · **UNIT** = automated with mocks/synthetic audio (no model or
hardware) · **UNVERIFIED** = not run in that environment; manual steps given.

## 0. The Speak redesign (2026-09-23)

The app was rebuilt around "choose a voice → type → Speak" on top of the same worker, engines and data model.
What was verified, and how:

| Area | How | Result |
|------|-----|--------|
| Opens on Speak (also first run), cursor in the editor; only Speak + Voices in the navigation | frontend (`app.boot.test`, `app.test` through the preview mock) | **UNIT** |
| Voice menu (names only, Clone New Voice…, Manage Voices), remembered voice | `speak.flow.test`, backend `test_speak` | **UNIT** |
| Text autosave (versioned script) + localStorage mirror; restored after restart; survives navigation | `speak.flow.test`; real worker restart in `test_real_speak` | **UNIT / PASS** |
| Ctrl+Enter / Speak = plan → generate → assemble → keep → auto-play; progress "Generating speech — 3 of 12"; repeated presses ignored; text edited mid-run; Stop/Esc cancels via the worker | `speak.flow.test` (call order asserted) | **UNIT** |
| Voice-aware reuse (`only_changed`): unchanged text reuses takes with no GPU work; one edited paragraph regenerates alone; a new voice / edited sample / other controls regenerate; pre-0002 takes never reused | backend `test_speak`; real Qwen in `test_real_speak` | **UNIT / PASS** |
| Recent: every result has its own file (never overwritten); bounded to 30; pruning of superseded takes | backend `test_speak`; `test_real_speak` | **UNIT / PASS** |
| Save Audio: the result's own file → `export.render` with the Settings preset; MP3/FLAC from the menu | `speak.flow.test`, backend `test_speak`; real 24-bit WAV export in `test_real_speak` | **UNIT / PASS** |
| Clone Voice — record: existing `record.*` API, script to read, level, timer; DEVICE_UNAVAILABLE in plain words | `voices.recorder.test`, `clone.flow.test` | **UNIT** (no live microphone in this run) |
| Clone Voice — file: picker, drag & drop (non-audio refused), corrupt file explained | `clone.flow.test` | **UNIT** |
| Automatic reference range (`audio.suggest_reference`): phrase-aligned, 8–15 s preferred, plain problem codes; unreliable → trim editor | backend `test_speak` (synthetic phrases, quiet, clipped, noisy, silent, short, pause-free); real espeak speech in `test_real_speak` | **UNIT / PASS** — picked two whole sentences (9.98 s); Whisper transcribed them word-for-word |
| Automatic local transcription of exactly that range; confidence reported; Edit Sample to correct words | `clone.flow.test`; real Whisper in `test_real_speak` | **UNIT / PASS** |
| Voice persisted, selected on Speak, selectable in the menu; created mid-run → selected when the run ends | `clone.flow.test`; real `voices.create` in `test_real_speak` | **UNIT / PASS** |
| Model missing → one dialog with name, size, source + pinned revision, license; download only on click; optional model can be deferred; offline mode explains instead; no loop when closed | `speak.flow.test`, `clone.flow.test`, `speak.logic.test` | **UNIT** |
| Offline mode enforced by the worker; installed models keep working | `settings.advanced.test`; real: download refused + Speak works offline in `test_real_speak` | **UNIT / PASS** |
| Advanced settings render only engine-declared controls (switching engine switches controls; no seed for engines without seeds) | `settings.advanced.test` | **UNIT** |
| Plain-language errors (GPU_OOM, MODEL_MISSING, DEVICE_UNAVAILABLE, …) with the structured error one click away | `speak.logic.test`, `speak.flow.test` | **UNIT** |
| Migration 0002 on a v1 database (rows kept, new columns NULL) | backend `test_speak` | **UNIT** |
| The real desktop app (release build, WebKitGTK under XWayland on Pop!_OS COSMIC) with real Qwen3-TTS, isolated data dir with one voice cloned through the worker (automatic range + Whisper transcript) | manual, 2026-09-23 | **PASS** — opens on Speak with the voice selected; typed text → Speak → "Loading the voice model…" → result playable in the window (played to the end), Recent filled, a repeated Speak made a fresh reading. Not exercised in this run: a live microphone recording, the native Save dialog, drag-and-drop from a file manager. |
| `.deb` package (`scripts/build.sh --deb-only`) | built 2026-09-23 | **PASS** — contains `jobs/speak.py`, migration `0002_speak.sql`, one desktop file; not installed over the existing installation in this run |
| Independent review of the whole change (fresh reviewer, read-only) | 2026-09-23 | 12 confirmed findings (7 medium, 5 low), all fixed with regression tests: settings erased when Speak was pressed before the engine list loaded; Cancel in Edit Sample from the ready step lost the sample; auto-filled words recorded as reviewed; an auto-play firing later on return to Speak; focus lost when Speak turned into Stop; the result below the fold at 720×560; a model-download loop while a download was running; cloning from the project editor jumping to Speak; no retry after a failed startup load; Stop ignored during the last step; a stopped "say it again" redoing finished sentences; deleting the voice a run was using. Also: script-version race between autosave and planning, and concurrent first `speak.session` calls. |
| Regressions found while building it: dialog focus jumped back to the first control on every keystroke when the owner re-rendered; "Use Voice" before Speak loaded was overwritten by the remembered voice; a voice created during a run was not selected | `ui.test`, `voices.page.test`, `clone.flow.test` | **UNIT** (fixed) |

## 1. Automated suites

| Suite | Command | Result |
|-------|---------|--------|
| Backend unit (mocked engines, synthetic audio) | `backend/.venv/bin/python -m pytest backend/tests -m "not realmodel"` | **190 passed, 1 failed, 3 skipped** (2026-09-23; the skips are real-model tests without `SFVS_REAL_MODELS=1`). The failure is `test_record.py::test_incremental_growth_levels_and_stop`, a timing-sensitive recorder test in unchanged code: it failed in full runs while the machine was at load average ~26 from unrelated jobs, passes when run alone, and passed in the full runs earlier the same day (188 passed before the review fixes added 3 tests). |
| Backend real-model integration | `SFVS_REAL_MODELS=1 … pytest backend/tests/test_real_*.py` | **PASS** (re-run 2026-09-23 on an RTX 5060 Ti 16 GB: `test_real_qwen` 4, `test_real_whisper` 3, `test_real_e2e` 1 and the new `test_real_speak` 1 passed; `test_real_chatterbox` skipped — its optional environment is not installed on this machine. Earlier run 2026-09-18: 12 passed.) Note: espeak-ng silently writes nothing when its output path is very long (> ~200 chars), which makes the espeak-based tests skip; keep `SFVS_REAL_SCRATCH` short. |
| Frontend (vitest) | `cd frontend && npm test -- --run` | **160 passed (20 files)** (2026-09-23) |
| Frontend typecheck + production build | `cd frontend && npm run build` | **PASS** |
| Rust shell | `cd src-tauri && cargo test --lib --tests --bins` | **3 passed** (2026-09-23, linked against installed WebKitGTK). Supervisor harness: `cargo test --manifest-path src-tauri/tests/supervisor-harness/Cargo.toml` **14 passed** (3 + 11). `cargo test` doctests can fail if `rustdoc` cannot load `libLLVM.so` from the Rust toolchain — not an app defect. |
| Packaged `.deb` + AppImage | `scripts/build.sh` / `scripts/install-linux.sh` | **PASS** (re-run 2026-09-20) — `Shadowfetch Voice Studio_0.1.1_amd64.deb`. One desktop file (`com.shadowfetch.voicestudio.desktop`). Managed runtime is a real venv under `$XDG_DATA_HOME/com.shadowfetch.voicestudio/runtime` (not a checkout symlink). AppImage bundling with `linuxdeploy` is best-effort and may fail (FUSE / icon layout); the `.deb` is the supported standalone install. |

## 2. Environment diagnostics (`scripts/doctor.sh`, `system.diagnostics`)
- GPU, driver, VRAM, utilisation, CPU, RAM, free disk, FFmpeg version, audio devices: detected live — nothing hardcoded. **PASS**
- Real CUDA smoke test: bf16 2048² matmul on NVIDIA; CUDA architectures reported by `torch.cuda.get_arch_list()`. **PASS**
- PortAudio (`libportaudio2`) present; PipeWire/PulseAudio session used for playback. **PASS**

## 3. Core path (real models, through the real worker process over JSON lines) — `backend/tests/test_real_e2e.py`
Reference speech: espeak-ng (intelligible synthetic speech with a known transcript). This proves the pipeline, **not**
voice fidelity — no authorized human recording is used here (see §6 for the manual listening checklist).

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
| Microphone disconnection | unit: backend process death → `DEVICE_UNAVAILABLE` (`test_record.py`); live unplug not exercised | **UNIT / UNVERIFIED (hardware)** |
| Input monitoring | unit: session feeds `MemoryMonitor` while paused; `record.start` attaches when `create_monitor` succeeds and keeps recording when it fails (`test_record.py`) | **UNIT** |
| Fine-tuned Qwen `custom_voice` | unit: capabilities/speaker control, marker prompt cache, `generate_custom_voice` without torch; `use_existing_dir` warns (`test_engines_caps.py`, `test_models.py`) | **UNIT** |
| Reference processing on derived wav | unit: stored trim/highpass/normalize applied at working rate; `prepare_reference` is not peak-normalized again (`test_store.py`) | **UNIT** |
| Multi-paragraph order + persistence across restart | real (E2E) | **PASS** |
| Exports: duration, sample rate, nonempty, finite samples | real (E2E) + unit | **PASS** |

## 5. Not verified in that environment (and how to verify)
- **Speak redesign, by hand:** live microphone recording through Clone Voice → Record Voice (real device), the native
  Save Audio dialog, dropping a file from a file manager onto the window, and the layout at 1280×800 / 1920×1080 in the
  installed app (the browser-preview screenshots in `docs/screenshots/` show the same React UI in Chromium).
- **Native window chrome at 1280×800 and 1920×1080.** Screenshots in `docs/screenshots/` are the browser preview
  (PREVIEW MOCK) of the same React UI. Install the `.deb` and walk Speak → Clone Voice → Voices → Settings at both sizes.
- **Microphone recording with a real microphone.** Manual: Clone Voice → Record Voice → pick the microphone → record
  30 s → stop; expect "Voice sample ready" with a clean ~10 s part and its words. Then unplug the device mid-recording;
  expect "Voice Studio can't access that microphone…" and Start over.
- **Voice fidelity with an authorized human recording.** Manual listening checklist in §6.

## 6. Listening checklist (manual)
Clone your own voice (Record Voice, 30–60 s), paste a 3-paragraph script on Speak, press Speak, and listen for:
missing words · repeated words/phrases · a voice change between segments · clipping or distortion ·
unnatural joins at sentence/paragraph boundaries · echo of the reference's last words at segment starts
(a known Qwen3-TTS behaviour; choose references that end cleanly) · speaking rate versus the reference.
Automated checks above prove intelligibility only, not naturalness.
