# Shadowfetch Voice Studio — architecture

```
┌──────────────────────────── Tauri 2 desktop shell (Rust) ────────────────────────────┐
│  typed #[tauri::command]s  •  worker supervisor (spawn/restart/health)  •  dialogs    │
│  events: worker://progress, worker://event, worker://status   •  asset protocol      │
└───────────────┬──────────────────────────────────────────────────────┬────────────────┘
                │ JSON lines (stdin/stdout)                            │ invoke()/listen()
┌───────────────▼──────────────────────────────┐        ┌──────────────▼────────────────┐
│ main worker  python -m shadowfetch_worker    │        │ frontend  React+TS+Vite+Tailwind│
│  rpc.py: dispatch, threads, cancel, GPU lock │        │  lib/api.ts (typed client)      │
│  jobs/*: audio, record, transcribe, tts,     │        │  pages: Home Voices Create      │
│          voices, projects, library, export,  │        │         Library Settings Setup  │
│          models, backup, engines, system     │        │  components: Waveform, Meter…   │
│  store/: SQLite + migrations                 │        └───────────────────────────────┘
│  audio/: ffmpeg/ffprobe, peaks, stats, trim, assemble, loudness, export                │
│  record/: sounddevice (PortAudio) or ffmpeg-pulse fallback → incremental 24-bit WAV    │
│  models/: registry, HF downloads (subprocess, cancellable), verification, offline      │
│  engines/manager.py: spawns engine hosts, one loaded engine at a time, idle unload     │
└───────┬───────────────────────────────┬───────────────────────────────────────────────┘
        │ same protocol                  │
┌───────▼───────────────┐   ┌───────────▼─────────────┐
│ engine host (env main)│   │ engine host (env chatterbox)│   python -m shadowfetch_worker.engine_host --engine <id>
│  qwen3_tts adapter    │   │  chatterbox_turbo adapter │   torch lives ONLY in these processes
└───────────────────────┘   └───────────────────────────┘
```

## Principles
- **Audio + transcript are the source of truth.** Everything else (working wav, peaks, engine prompt caches,
  derived reference files) is regenerable and keyed by a fingerprint (asset sha256 + trim + transcript + processing
  + model revision). Change any input → cache invalid.
- **Nothing expensive on the UI thread.** The UI only awaits typed commands and renders progress events.
- **Truthful capabilities.** Engine adapters publish `Capabilities`; the UI never shows a control the adapter
  did not declare. Post-processing controls are labelled as post-processing.
- **Local only.** No telemetry; network is used only for user-approved model downloads and blocked entirely in
  offline mode (`HF_HUB_OFFLINE=1` in every process + explicit checks).
- **Least privilege.** The frontend cannot run shell commands or read arbitrary files. Every path the worker
  touches is inside the app data dir or was picked by the user through a native dialog and re-validated.

## Directories
| path | purpose |
|------|---------|
| `frontend/` | React app (Vite). `src/lib/api.ts` is the only place that calls `invoke`. |
| `src-tauri/` | Rust shell: `src/worker.rs` (supervisor), `src/commands.rs`, `tauri.conf.json`, `capabilities/` |
| `backend/shadowfetch_worker/` | Python worker package (see tree above) |
| `backend/envs/<id>/` (dev) or `<data>/runtime/envs/<id>/` (packaged) | isolated Python environments |
| `scripts/` | doctor / bootstrap / dev / test / build |
| `tests/` | backend pytest (mocked + `-m realmodel`), frontend vitest, IPC tests |
| `docs/` | this file, PROTOCOL.md, MODEL_LICENSES.md, THIRD_PARTY_NOTICES.md, TEST_REPORT.md |

## Data layout (`$XDG_DATA_HOME/shadowfetch-voice-studio`)
```
studio.db                      SQLite (WAL); migrations in backend/.../store/migrations
recordings/<asset_id>/         original.<ext> (untouched) + working.wav (float32 mono 48k) + meta.json
voices/<voice_id>/references/<reference_id>/  reference.<engine>.wav (derived, engine-specific)
projects/<project_id>/segments/<segment_id>/<take_id>.wav  master.wav  script versions in DB
exports/                       default export location (user may pick elsewhere)
models/hf/                     Hugging Face cache (HF_HUB_CACHE) — outside the app package
runtime/envs/                  managed Python envs (packaged mode)
logs/worker.log                redacted
```
Config: `$XDG_CONFIG_HOME/shadowfetch-voice-studio/settings.json`. Cache: `$XDG_CACHE_HOME/…/{peaks,prompts,tmp}` — deletable.

## Generation pipeline (Create page)
1. `tts.plan` splits the script into paragraphs → sentences → segments ≤ `max_chars` (engine limit clamps it),
   applies the project's pronunciation substitutions and optional number spelling, returns the plan with
   substitutions listed. Segments keep their ids (and takes) when their text is unchanged.
2. `tts.generate` runs segment by segment through the loaded engine host (one GPU job at a time), emitting
   `Generating segment i of N`. Each output is a **take** file; the segment's selected take defaults to the newest.
   Cancel/failure keeps finished takes.
3. `tts.assemble` concatenates selected takes with conservative silence trimming (−50 dBFS threshold, 40 ms pad,
   5 ms fades) and configurable sentence/paragraph pauses into `master.wav` (24-bit PCM at the engine rate).
4. `export.render` produces WAV/FLAC/MP3 copies with ffmpeg (optional two-pass loudnorm to a named target,
   measured with ebur128), atomic write, ffprobe validation, optional AI-generated metadata.

## Engine hosts
Started lazily by `EngineManager`; only one engine is loaded at a time by default (`gpu_jobs = 1`). `engine.unload`
or idle timeout kills the host process, which is the only reliable way to return VRAM. A host that dies mid-job
yields `ENGINE_CRASHED` with the completed segments preserved.
