# Worker protocol (v1)

The desktop shell (Rust, Tauri 2) supervises one **main worker** process:

```
python -m shadowfetch_worker --data-dir <app data dir> --config-dir <app config dir> --cache-dir <app cache dir>
```

The worker speaks **JSON Lines over stdin/stdout**. `stdout` is reserved for protocol messages —
the worker redirects Python's `sys.stdout` to `stderr` at startup so library chatter (tqdm, transformers,
torch) can never corrupt the channel. `stderr` is captured by the shell into the log file.

Model inference runs in **engine host** child processes (one per Python environment), spawned by the
main worker with the same protocol. The shell never talks to engine hosts directly.

## Envelope

Every line is one JSON object with `"v": 1`.

| direction | shape |
|-----------|-------|
| shell → worker | `{"v":1,"type":"request","id":"<uuid>","method":"<ns.method>","params":{...}}` |
| shell → worker | `{"v":1,"type":"cancel","id":"<request id>"}` |
| worker → shell | `{"v":1,"type":"progress","id":"<request id>","stage":"<str>","message":"<human text>","current":3,"total":12,"detail":{...}}` |
| worker → shell | `{"v":1,"type":"result","id":"<request id>","result":{...}}` |
| worker → shell | `{"v":1,"type":"error","id":"<request id>","error":{"code":"<CODE>","message":"<human text>","details":{...},"recoverable":true}}` |
| worker → shell | `{"v":1,"type":"event","event":"<name>","data":{...}}` (unsolicited) |
| worker → shell | `{"v":1,"type":"ready","worker":"main","protocol":1,"pid":123}` (first line after start) |

Rules
- Exactly one `result` **or** `error` per request id. `progress` lines may precede it.
- `current`/`total` are **measured** counts (segments, files, bytes); never invented percentages.
  When only bytes are known, `detail.bytes_done`/`detail.bytes_total` are set.
- Requests run concurrently on worker threads. Methods marked **GPU** are serialized by a global GPU lock
  (default: one GPU-heavy job at a time); a second GPU request waits and reports `stage:"queued"`.
- `cancel` is best effort. A cancelled request ends with `error.code == "CANCELLED"`. Finished partial outputs
  (e.g. completed segments) are kept and reported in `error.details`.
- Every error carries a stable `code` (below), a human `message`, and `recoverable` (true = user can retry
  without restarting).

## Error codes

`INVALID_PARAMS`, `NOT_FOUND`, `CANCELLED`, `MODEL_MISSING`, `MODEL_INVALID`, `MODEL_LOAD_FAILED`,
`ENGINE_UNAVAILABLE` (env not installed), `ENGINE_CRASHED`, `GPU_OOM`, `OFFLINE_BLOCKED` (network needed
but offline mode on), `DOWNLOAD_FAILED`, `DISK_FULL`, `DEVICE_UNAVAILABLE` (audio device gone),
`PERMISSION_DENIED`, `UNSUPPORTED_FILE`, `CORRUPT_FILE`, `EMPTY_AUDIO`, `FFMPEG_FAILED`, `DB_ERROR`,
`INTERNAL`.

## Events (unsolicited)

| event | data |
|-------|------|
| `record.level` | `{session_id, peak_dbfs, rms_dbfs, clipped, elapsed_s, bytes_written}` (~10 Hz while recording) |
| `record.state` | `{session_id, state: "recording"\|"paused"\|"stopped"\|"error", reason?}` |
| `engine.state` | `{engine_id, state: "unloaded"\|"loading"\|"loaded"\|"error", model_id?, message?, vram_bytes?}` |
| `model.state` | `{model_id, state: "missing"\|"downloading"\|"installed"\|"error"\|"verifying", bytes_done?, bytes_total?, message?}` |
| `playback.level` | reserved |
| `worker.log` | `{level, message}` (rare; important warnings only) |

## Methods

Paths are always absolute and must be inside the app data dir or explicitly user-picked
(the shell validates picked paths; the worker re-validates against `allowed_roots`).

### system
- `system.ping` → `{ok:true, uptime_s}`
- `system.diagnostics` → `{os, cpu, ram_total_bytes, ram_free_bytes, gpus:[{index,name,driver,vram_total_bytes,vram_used_bytes,utilization_pct}], disk:{path, free_bytes, total_bytes}, ffmpeg:{path,version}|null, ffprobe:{...}|null, python:{main:{version,path}, engines:{<engine_id>:{installed:bool, python?, torch?, cuda_ok?:bool, cuda_device?:string, error?}}}, audio:{inputs:[Device], outputs:[Device], default_input?, default_output?}, offline:bool, data_dir, models_dir}`
  `Device = {index, name, hostapi, max_input_channels, max_output_channels, default_samplerate}`
- `system.cuda_smoke_test` **GPU** `{engine_id}` → `{ok, device, torch_version, cuda_version, matmul_ms, error?}` (runs a real matmul in the engine env)
- `system.gpu_status` → `{gpus:[...]}` (cheap, polled)
- `system.set_offline` `{offline:bool}` → `{offline}`
- `system.settings.get` → `{...all settings...}` ; `system.settings.set` `{patch:{...}}` → `{...}`
- `system.storage_usage` → `{data_dir, models_bytes, recordings_bytes, projects_bytes, cache_bytes, free_bytes}`
- `system.clear_cache` `{kinds:["prompts","peaks","tmp"]}` → `{freed_bytes}` (never touches recordings/masters)
- `system.log_bundle` → `{path}` (redacted diagnostics zip)

### audio
- `audio.probe` `{path}` → `{format, codec, duration_s, sample_rate, channels, bit_depth?, bitrate?, size_bytes}` (ffprobe; `UNSUPPORTED_FILE`/`CORRUPT_FILE` on failure)
- `audio.import` `{path, kind:"reference"|"other"}` → `{asset_id, original_path, working_path, probe, peaks_path, stats}`
  Copies the original unchanged into `data/recordings/<id>/original.<ext>`, decodes ONCE to `working.wav`
  (float32, mono, engine-agnostic 48 kHz), computes peaks + stats.
- `audio.peaks` `{path, points?:2000}` → `{points, duration_s, sample_rate, peaks:[[min,max],...]}` (cached)
- `audio.stats` `{path, start_s?, end_s?}` → `{duration_s, sample_rate, channels, peak_dbfs, rms_dbfs, clipping_samples, leading_silence_s, trailing_silence_s, silence_ratio, warnings:[{code, message, heuristic:true}]}`
- `audio.trim` `{path, start_s, end_s, out_path?}` → `{path, duration_s}` (writes a new file; never modifies input)
- `audio.prepare_reference` `{asset_id, start_s, end_s, engine_id, processing?:{normalize_peak_dbfs?:-3}}` → `{reference_id, path, sample_rate, channels, duration_s, stats}` — derived file matching the engine's requirements (sample rate/channels), stored under `data/voices/<voice_id?>/references/`.
- `audio.preview_processing` `{path, processing:{...}}` → `{path}` (temporary copy for A/B; reversible)
- `audio.play_device_test` `{device_index?}` → `{ok}` (plays a short tone; used by setup)

### record
- `record.devices` → `{inputs:[Device], default_input}`
- `record.start` `{device_index?, sample_rate?:48000, channels?:1, subtype?:"PCM_24", session_name?}` → `{session_id, path, negotiated:{sample_rate, channels, dtype, subtype, hostapi, device_name, latency_s}, notes:[...]}`
- `record.pause` / `record.resume` / `record.stop` `{session_id}` → `{session_id, path, duration_s, stats, negotiated}`
- `record.discard` `{session_id}` → `{ok}`
- `record.scripts` → `{scripts:[{id,title,style,text,approx_seconds}]}` (the three guided reading scripts)

### transcribe
- `transcribe.models` → `{models:[{id, repo, size_bytes?, installed:bool, device:"cpu"|"cuda"}]}`
- `transcribe.run` `{path, start_s?, end_s?, model_id?, language?, device?:"cpu"|"cuda"}` → `{text, language, language_probability, segments:[{start,end,text}], model_id, device, duration_s, elapsed_s}` (**GPU** only when device == "cuda")

### engines
- `engine.list` → `{engines:[{id, name, installed:bool, state, model_state, capabilities?:Capabilities}]}`
- `engine.capabilities` `{engine_id}` → `Capabilities`
- `engine.load` **GPU** `{engine_id, model_id?}` → `{engine_id, model_id, revision, load_ms, vram_bytes?}`
- `engine.unload` `{engine_id}` → `{ok}`
- `engine.prepare_reference` **GPU** `{engine_id, reference_id}` → `{prompt_cache_id, path, engine_id, model_revision, fingerprint}` — engine-specific reusable prompt; regenerable cache keyed by (reference file hash, transcript, preprocessing, model revision).
- `engine.generate` **GPU** `{engine_id, reference_id, text, language, settings:{...caps.controls...}, seed?, out_dir, tag?}` → `{path, sample_rate, duration_s, seed?, elapsed_s, normalized_text, warnings:[...]}` (single segment)

`Capabilities`:
```json
{"id":"qwen3-tts-base","name":"Qwen3-TTS 1.7B Base","version":"<pkg version>","model_id":"...","output_sample_rate":24000,
 "languages":[{"code":"en","label":"English","engine_value":"English"}],
 "reference":{"needs_transcript":true,"min_seconds":3,"max_seconds":30,"recommended_seconds":[8,15],"sample_rate":24000,"channels":1,"notes":"..."},
 "controls":[{"id":"temperature","label":"Sampling temperature","type":"float","min":0.1,"max":1.5,"step":0.05,"default":0.9,"description":"...", "advanced":true}],
 "tags":[{"token":"[laugh]","label":"Laugh"}],
 "max_chars_per_request":400,"supports_cancel":true,"supports_seed":true,"supports_reusable_prompt":true,
 "watermark":null,"post_processing":[{"id":"speed","label":"Speed (post-processing)","type":"float","min":0.8,"max":1.25,"default":1.0}],
 "cancel_granularity":"segment"}
```
The UI renders **only** what appears here.

### tts (project-level orchestration, main worker)
- `tts.plan` `{project_id, script_text, engine_id, options:{max_chars?, paragraph_pause_ms?, sentence_pause_ms?, pronunciation:[{from,to}], spell_numbers?:bool}}` → `{segments:[{index, paragraph, text, normalized_text, substitutions:[{from,to,count}], char_count}], engine_id, warnings}`
- `tts.generate` **GPU** `{project_id, segment_indices?:[...] , take_label?, engine_id, reference_id, language, settings, seed?}` → `{takes:[{segment_index, take_id, path, duration_s, seed}], skipped:[...], elapsed_s}` — progress `"Generating segment 3 of 12"`. Keeps completed segments on cancel/failure.
- `tts.assemble` `{project_id, take_selection?:{segment_index:take_id}, paragraph_pause_ms?, sentence_pause_ms?}` → `{master_path, duration_s, sample_rate, segments_used}`
- `tts.compare_engines` **GPU** `{project_id, engine_ids:[...], segment_index}` → `{results:[{engine_id, take_id, path, loudness_matched_preview_path}]}` (sequential; originals untouched)

### voices / projects / library (persistence)
- `voices.create` `{name, tags, language, rights_confirmed:true, asset_id, trim:{start_s,end_s}, transcript, engine_id?, processing:[...]}` → `Voice`
- `voices.list` / `voices.get {id}` / `voices.update {id, patch}` / `voices.delete {id, force?}` (warns with `details.used_by_projects` unless force)
- `voices.add_reference {voice_id, asset_id, trim, transcript}` → `Reference` ; `voices.select_reference {voice_id, reference_id}`
- `projects.create` `{name, voice_id?, reference_id?, engine_id?, folder?}` → `Project`
- `projects.list {query?, tags?, favorite?, archived?, sort?}` / `projects.get {id}` (includes script, segments, takes, exports) / `projects.update {id, patch}` / `projects.duplicate {id}` / `projects.archive {id, archived}` / `projects.delete {id, confirm:true}`
- `projects.save_script {id, text}` → `{script_version}` (autosave; keeps versions)
- `projects.select_take {id, segment_index, take_id}`
- `library.search {query}` → `{projects:[...], voices:[...]}`
- `library.folders` / `library.tags`
- `backup.export {project_id, out_path}` → `{path, size_bytes}` ; `backup.import {path}` → `{project_id}` (zip; manifest.json + assets; traversal + size guarded)

### export
- `export.render` `{project_id, master_path?, format:"wav"|"flac"|"mp3", out_path, wav_bit_depth?:16|24|32f, sample_rate?:"native"|48000, mp3_bitrate_kbps?:128|192|256|320, mp3_vbr_quality?:0-9, loudness?:{target_id:"ebu-r128-podcast-16"|"streaming-14"|"broadcast-23"}, ai_metadata?:true}` → `{path, size_bytes, probe, loudness_measured?:{integrated_lufs, true_peak_dbtp, lra}, collision_renamed?:bool}` (atomic write; never overwrites the master)
- `export.loudness_targets` → `{targets:[{id,label,integrated_lufs,true_peak_dbtp,lra,description}]}`
- `export.open_folder {path}` → handled by the shell (opener plugin), not the worker.

### models
- `models.list` → `{models:[{id, engine_id?, kind:"tts"|"asr", repo, revision_pinned, revision_installed?, size_bytes?, license, state, path?, error?}]}`
- `models.download` `{model_id}` → progress (bytes) → `{model_id, path, revision, size_bytes}` (refused with `OFFLINE_BLOCKED` when offline)
- `models.cancel_download` `{model_id}` → `{ok}`
- `models.verify` `{model_id}` → `{ok, missing_files:[...], revision}`
- `models.use_existing_dir` `{model_id, path}` → `{ok, revision?, warnings}`
- `models.remove` `{model_id, confirm:true}` → `{ok}`

## Engine host protocol
Same envelope; methods `engine.caps`, `engine.load {model_dir, device, dtype}`, `engine.unload`, `engine.prepare {reference_path, transcript, language, cache_path}`, `engine.generate {text, language, prompt_cache_path|reference_path, settings, seed, out_path}`, `engine.health`. Hosts are started with
`<env python> -m shadowfetch_worker.engine_host --engine <id>` and inherit `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE` from the main worker's offline setting.
