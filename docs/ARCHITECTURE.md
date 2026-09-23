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
│  jobs/*: audio, record, transcribe, tts,     │        │  pages: Speak Voices Settings   │
│          speak, voices, projects, library,   │        │  + Setup, Projects, Editor      │
│          export, models, backup, engines,    │        │  components: Waveform, Meter…   │
│          system                              │        │                                 │
│  store/: SQLite + migrations                 │        └───────────────────────────────┘
│  audio/: ffmpeg/ffprobe, peaks, stats, trim, assemble, loudness, export                │
│  record/: sounddevice (PortAudio) or ffmpeg-pulse fallback → incremental 24-bit WAV    │
│          optional input monitor (PortAudio out, then paplay/ffmpeg pulse)              │
│  models/: registry, HF downloads (subprocess, cancellable), verification, offline      │
│  engines/manager.py: spawns engine hosts, one loaded engine at a time, idle unload     │
└───────┬───────────────────────────────┬───────────────────────────────────────────────┘
        │ same protocol                  │
┌───────▼───────────────┐   ┌───────────▼─────────────┐
│ engine host (env main)│   │ engine host (env chatterbox)│   python -m shadowfetch_worker.engine_host --engine <id>
│  qwen3_tts adapter    │   │  chatterbox_turbo adapter │   torch lives ONLY in these processes
│  (base + custom_voice)│   │                           │
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

## Simple on top, sophisticated underneath
The UI has two places — **Speak** and **Voices** — plus Settings behind a gear. Everything the old workstation UI asked
the user to do by hand now happens underneath, through the same methods:

| The user does | Underneath |
|---------------|------------|
| Picks a voice | `projects.update {voice_id}` on the Speak scratch project; generation uses the voice's *selected* reference |
| Types | `projects.save_script` (debounced, versioned) + a localStorage mirror until the worker has it |
| Presses Speak | `tts.plan` → `tts.generate {only_changed}` (or `{regenerate_all}` when text and voice are unchanged) → `tts.assemble` → `speak.remember` → auto-play |
| Presses Stop | `worker_cancel` on the running request (finished segments are kept) |
| Save Audio | `export.render {master_path: <Recent file>}` with the Settings preset (24-bit WAV by default) |
| Clone Voice | `record.*` or `audio.import` → `audio.suggest_reference` → `transcribe.run` (that range) → `voices.create` |
| Model missing | readiness check (`engine.list` / `models.list`) → one dialog → `models.download` (size, source, license shown first) |

**The Speak scratch project.** `speak.session` creates (once) an ordinary project whose id is kept in
`settings.speak_project_id`; `projects.list` and `library.search` leave it out. Its script is the editor text, its voice
the selected voice, its `settings.plan/controls/seed` and `settings.speak.{engine_id, language}` the Advanced overrides.

**Voice-aware reuse.** Takes record the reference fingerprint and language they were made with (migration 0002). With
`only_changed`, `tts.generate` reuses a segment's selected take only when engine, reference id + fingerprint, language
and controls all match — so switching voices or editing a voice sample never replays stale audio, while editing one
sentence of a long text regenerates just that segment. The default mode (used by the project editor) is unchanged.

**Recent.** `speak.remember` hard-links (or copies) the freshly assembled `master.wav` to
`projects/<speak>/history/<id>.wav` and records it in `speak_history`; `tts.assemble` replaces `master.wav` atomically, so
a history file is never overwritten. It then prunes the scratch project's superseded takes and old plan segments and
keeps the newest 30 results.

**Automatic reference selection.** `audio.suggest_reference` (`audio/analysis.suggest_reference_range`) finds pauses
(≥ 0.2 s under an adaptive noise-relative threshold), enumerates phrase-aligned ranges inside the engine's reference
window, and scores them by speech ratio, closeness to the recommended length, clipping, level stability and long inner
pauses. It reports `reliable=false` when no clean-edged range exists (the UI then opens the trim editor) and plain
problem codes (`NO_SPEECH`, `TOO_SHORT`, `TOO_QUIET`, `CLIPPING`, `NOISY`, `MOSTLY_SILENT`, `SHORT`) — heuristics, labelled
as such. Transcription then covers exactly that range; `transcribe.run` also reports a confidence so the UI can suggest a
review. Every voice keeps its words next to its audio, whichever engine speaks with it.

## Directories
| path | purpose |
|------|---------|
| `frontend/` | React app (Vite). `src/lib/api.ts` is the only place that calls `invoke`. |
| `src-tauri/` | Rust shell: `src/worker.rs` (supervisor), `src/commands.rs`, `tauri.conf.json`, `capabilities/` |
| `backend/shadowfetch_worker/` | Python worker package (see tree above) |
| `backend/envs/<id>/` (dev) or `<data>/runtime/envs/<id>/` (packaged, never a checkout symlink) | isolated Python environments |
| `scripts/` | doctor / bootstrap / dev / test / build |
| `tests/` | backend pytest (mocked + `-m realmodel`), frontend vitest, IPC tests |
| `docs/` | this file, PROTOCOL.md, MODEL_LICENSES.md, THIRD_PARTY_NOTICES.md, TEST_REPORT.md, USER_GUIDE.md, FINETUNING.md |

## Data layout (`$XDG_DATA_HOME/com.shadowfetch.voicestudio`)
```
studio.db                      SQLite (WAL); migrations in backend/.../store/migrations
recordings/<asset_id>/         original.<ext> (untouched) + working.wav (float32 mono 48k) + meta.json
voices/<voice_id>/references/<reference_id>/  reference.<engine>.wav (derived, engine-specific)
projects/<project_id>/segments/<segment_id>/<take_id>.wav  master.wav  script versions in DB
projects/<speak_project_id>/history/<speech_id>.wav   Recent results of the Speak screen (own files)
exports/                       default export location (user may pick elsewhere)
models/hf/                     Hugging Face cache (HF_HUB_CACHE) — outside the app package
runtime/envs/                  managed Python envs (packaged mode)
logs/worker.log                redacted
```
Config: `$XDG_CONFIG_HOME/com.shadowfetch.voicestudio/settings.json`. Cache: `$XDG_CACHE_HOME/…/{peaks,prompts,tmp}` — deletable.

## Generation pipeline (Speak and the project editor)
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
yields `ENGINE_CRASHED` with the completed segments preserved. After load, live `engine.caps` replace the static
adapter caps so a fine-tuned Qwen `custom_voice` checkpoint can expose its speaker control instead of ICL cloning.
