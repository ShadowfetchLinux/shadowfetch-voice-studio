/**
 * TypeScript mirror of docs/PROTOCOL.md (worker protocol v1) plus the Rust shell command surface.
 *
 * Everything the UI sends to or receives from the worker is typed here. Shapes for persisted rows
 * (Voice, Reference, Project, Segment, Take, Export) follow backend/shadowfetch_worker/store/migrations/0001_init.sql
 * after `row_to_dict` (JSON columns unpacked, `*_json` suffix dropped, flags as booleans).
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable error codes from backend/shadowfetch_worker/protocol.py. `CLIENT` is UI-side only. */
export type ErrorCode =
  | "INVALID_PARAMS"
  | "NOT_FOUND"
  | "CANCELLED"
  | "MODEL_MISSING"
  | "MODEL_INVALID"
  | "MODEL_LOAD_FAILED"
  | "ENGINE_UNAVAILABLE"
  | "ENGINE_CRASHED"
  | "GPU_OOM"
  | "OFFLINE_BLOCKED"
  | "DOWNLOAD_FAILED"
  | "DISK_FULL"
  | "DEVICE_UNAVAILABLE"
  | "PERMISSION_DENIED"
  | "UNSUPPORTED_FILE"
  | "CORRUPT_FILE"
  | "EMPTY_AUDIO"
  | "FFMPEG_FAILED"
  | "DB_ERROR"
  | "INTERNAL"
  | "CLIENT";

export interface WorkerErrorShape {
  code: ErrorCode | string;
  message: string;
  details?: Record<string, unknown>;
  recoverable?: boolean;
}

/** Error thrown by `api.request` for every failed call (worker errors and shell/IPC failures alike). */
export class WorkerError extends Error {
  readonly code: ErrorCode | string;
  readonly details: Record<string, unknown>;
  readonly recoverable: boolean;
  readonly method?: string;

  constructor(shape: WorkerErrorShape, method?: string) {
    super(shape.message);
    this.name = "WorkerError";
    this.code = shape.code;
    this.details = shape.details ?? {};
    this.recoverable = shape.recoverable ?? true;
    this.method = method;
  }

  get cancelled(): boolean {
    return this.code === "CANCELLED";
  }

  static from(err: unknown, method?: string): WorkerError {
    if (err instanceof WorkerError) return err;
    if (err && typeof err === "object" && "code" in err && "message" in err) {
      const e = err as WorkerErrorShape;
      return new WorkerError(
        { code: String(e.code), message: String(e.message), details: e.details ?? {}, recoverable: e.recoverable ?? true },
        method,
      );
    }
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
    return new WorkerError({ code: "CLIENT", message, details: {}, recoverable: true }, method);
  }
}

// ---------------------------------------------------------------------------
// Envelope pieces that reach the UI
// ---------------------------------------------------------------------------

/** `worker://progress` payload. `current`/`total` are measured counts (segments, files, bytes). */
export interface Progress {
  id: string;
  stage: string;
  message: string;
  current?: number;
  total?: number;
  detail?: Record<string, unknown> & { bytes_done?: number; bytes_total?: number };
}

/** `worker://status` payload from the Rust supervisor. */
/** Supervisor snapshot; also the payload of `worker://status` (src-tauri/src/worker.rs `WorkerStatus`). */
export interface WorkerStatus {
  /** A worker process is up and answered `ready`. */
  running: boolean;
  restarts: number;
  last_error: string | null;
  /** The supervisor gave up (crash loop, no interpreter, shutdown); needs `worker_restart` or a successful bootstrap. */
  stopped: boolean;
  pid?: number | null;
  started_at_unix_ms?: number | null;
  pending?: number;
  python?: string;
  pythonpath?: string;
  mode?: string;
  python_found?: boolean;
}

// ---------------------------------------------------------------------------
// Unsolicited events (`worker://event` → {event, data})
// ---------------------------------------------------------------------------

export interface RecordLevel {
  session_id: string;
  peak_dbfs: number;
  rms_dbfs: number;
  clipped: boolean;
  elapsed_s: number;
  bytes_written: number;
}

export type RecordSessionState = "recording" | "paused" | "stopped" | "error";

export interface RecordStateEvent {
  session_id: string;
  state: RecordSessionState;
  reason?: string;
}

export type EngineLoadState = "unloaded" | "loading" | "loaded" | "error";

export interface EngineStateEvent {
  engine_id: string;
  state: EngineLoadState;
  model_id?: string | null;
  message?: string;
  vram_bytes?: number | null;
  revision?: string | null;
  last_used?: number;
}

export type ModelState = "missing" | "downloading" | "installed" | "error" | "verifying";

export interface ModelStateEvent {
  model_id: string;
  state: ModelState;
  bytes_done?: number;
  bytes_total?: number;
  message?: string;
}

export interface WorkerLogEvent {
  level: string;
  message: string;
}

/** Map of event name → payload; used by `events.on(name, cb)`. */
export interface WorkerEvents {
  "record.level": RecordLevel;
  "record.state": RecordStateEvent;
  "engine.state": EngineStateEvent;
  "model.state": ModelStateEvent;
  "playback.level": Record<string, unknown>;
  "worker.log": WorkerLogEvent;
}
export type WorkerEventName = keyof WorkerEvents;

// ---------------------------------------------------------------------------
// system.*
// ---------------------------------------------------------------------------

export interface Device {
  index: number;
  name: string;
  hostapi: string;
  max_input_channels: number;
  max_output_channels: number;
  default_samplerate: number;
}

export interface GpuInfo {
  index: number;
  name: string;
  driver: string;
  vram_total_bytes: number;
  vram_used_bytes: number;
  utilization_pct: number | null;
  compute_cap?: string | null;
  temperature_c?: number | null;
}

export interface ToolInfo {
  path: string;
  version: string;
}

export interface DiskInfo {
  path: string;
  free_bytes: number;
  total_bytes: number;
}

/** Result of Runtime.probe_env for one engine environment. */
export interface EngineEnvProbe {
  installed: boolean;
  python?: string;
  python_path?: string;
  torch?: string;
  cuda_available?: boolean;
  cuda_version?: string | null;
  cuda_device?: string;
  capability?: number[];
  arch_list?: string[];
  torch_error?: string;
  error?: string;
  ts?: number;
  [pkg: `pkg_${string}`]: string | null | undefined;
}

export interface AudioDevices {
  inputs: Device[];
  outputs: Device[];
  default_input?: number | null;
  default_output?: number | null;
  hostapis?: string[];
  error?: string;
}

export interface Diagnostics {
  os: { system: string; release: string; machine: string; pretty: string; session?: string; desktop?: string };
  cpu: { name: string; threads: number };
  ram: { total_bytes: number; available_bytes: number };
  gpus: GpuInfo[];
  disk: DiskInfo;
  models_disk?: DiskInfo;
  ffmpeg: ToolInfo | null;
  ffprobe: ToolInfo | null;
  python: { main: { version: string; path: string }; engines: Record<string, EngineEnvProbe> };
  audio: AudioDevices;
  offline: boolean;
  data_dir: string;
  models_dir: string;
  config_dir?: string;
  cache_dir?: string;
  warnings: string[];
}

export interface PingResult {
  ok: true;
  uptime_s: number;
  pid?: number;
}

export interface CudaSmokeParams {
  engine_id?: string;
}

export interface CudaSmokeResult {
  ok: boolean;
  device?: string;
  torch_version?: string;
  cuda_version?: string | null;
  matmul_ms?: number;
  vram_free_bytes?: number;
  vram_total_bytes?: number;
  error?: string;
}

export interface GpuStatus {
  gpus: GpuInfo[];
  engines?: Record<string, EngineStateEvent & { alive?: boolean }>;
}

/** Mirrors backend/shadowfetch_worker/settings.py `Settings`. */
export interface Settings {
  offline: boolean;
  models_dir: string;
  default_engine: string;
  default_language: string;
  asr_model: string;
  asr_device: "cpu" | "cuda";
  gpu_jobs: number;
  idle_unload_minutes: number;
  record_sample_rate: number;
  record_subtype: string;
  record_device_index: number | null;
  output_device_index: number | null;
  monitor_input: boolean;
  max_chars_per_segment: number;
  paragraph_pause_ms: number;
  sentence_pause_ms: number;
  export_default_format: string;
  export_wav_bit_depth: number;
  export_mp3_bitrate_kbps: number;
  export_ai_metadata: boolean;
  redact_logs: boolean;
  onboarding_done: boolean;
  rights_notice_accepted: boolean;
  engine_settings: Record<string, Record<string, unknown>>;
  /** The hidden scratch project behind the Speak screen (created by `speak.session`). */
  speak_project_id?: string | null;
  /** Play a Speak result as soon as it is ready. */
  speak_autoplay?: boolean;
  /** Save Audio: optional named loudness target (`export.loudness_targets` id). */
  export_loudness_target?: LoudnessTargetId | null;
  extra: Record<string, unknown>;
}
export type SettingsPatch = Partial<Settings>;

export interface StorageUsage {
  data_dir: string;
  models_bytes: number;
  recordings_bytes: number;
  voices_bytes?: number;
  projects_bytes: number;
  exports_bytes?: number;
  cache_bytes: number;
  free_bytes: number;
  total_bytes?: number;
}

export type CacheKind = "prompts" | "peaks" | "tmp";

// ---------------------------------------------------------------------------
// audio.*
// ---------------------------------------------------------------------------

export interface AudioProbe {
  format: string;
  codec: string;
  duration_s: number;
  sample_rate: number;
  channels: number;
  bit_depth?: number | null;
  bitrate?: number | null;
  size_bytes: number;
}

export interface AudioWarning {
  code: string;
  message: string;
  heuristic: true;
}

export interface AudioStats {
  duration_s: number;
  sample_rate: number;
  channels: number;
  peak_dbfs: number;
  rms_dbfs: number;
  clipping_samples: number;
  leading_silence_s: number;
  trailing_silence_s: number;
  silence_ratio: number;
  warnings: AudioWarning[];
}

export interface AudioImportParams {
  path: string;
  kind: "reference" | "other";
}

export interface AudioImportResult {
  asset_id: string;
  original_path: string;
  working_path: string;
  probe: AudioProbe;
  peaks_path: string;
  stats: AudioStats;
}

export type PeakPair = [min: number, max: number];

export interface AudioPeaksParams {
  path: string;
  points?: number;
}

export interface AudioPeaksResult {
  points: number;
  duration_s: number;
  sample_rate: number;
  peaks: PeakPair[];
}

export interface AudioStatsParams {
  path: string;
  start_s?: number;
  end_s?: number;
}

export interface AudioTrimParams {
  path: string;
  start_s: number;
  end_s: number;
  out_path?: string;
}

export interface AudioTrimResult {
  path: string;
  duration_s: number;
}

export interface ReferenceProcessing {
  normalize_peak_dbfs?: number;
  [key: string]: unknown;
}

export interface PrepareReferenceParams {
  asset_id: string;
  start_s: number;
  end_s: number;
  engine_id: string;
  processing?: ReferenceProcessing;
}

export interface PrepareReferenceResult {
  reference_id: string;
  path: string;
  sample_rate: number;
  channels: number;
  duration_s: number;
  stats: AudioStats;
}

export interface PreviewProcessingParams {
  path: string;
  processing: ReferenceProcessing;
}

export interface PlayDeviceTestParams {
  device_index?: number | null;
}

// ---------------------------------------------------------------------------
// record.*
// ---------------------------------------------------------------------------

export interface RecordDevicesResult {
  inputs: Device[];
  default_input: number | null;
}

export interface RecordStartParams {
  device_index?: number | null;
  sample_rate?: number;
  channels?: number;
  subtype?: string;
  session_name?: string;
  script_id?: string | null;
  take_number?: number;
}

export interface RecordNegotiated {
  sample_rate: number;
  channels: number;
  dtype: string;
  subtype: string;
  hostapi: string;
  device_name: string;
  latency_s: number;
}

export interface RecordStartResult {
  session_id: string;
  path: string;
  negotiated: RecordNegotiated;
  notes: string[];
  monitoring?: boolean;
  script_id?: string | null;
  take_number?: number | null;
}

export interface RecordSessionParams {
  session_id: string;
}

export interface RecordStopResult {
  session_id: string;
  path: string;
  duration_s: number;
  stats: AudioStats;
  negotiated: RecordNegotiated;
  asset_id?: string;
}

/** `record.pause` / `record.resume` only report the new session state (record/session.py). */
export interface RecordPauseResult {
  session_id: string;
  state: "paused" | "recording";
  elapsed_s: number;
}

export interface RecordScript {
  id: string;
  title: string;
  style: string;
  text: string;
  approx_seconds: number;
}

// ---------------------------------------------------------------------------
// transcribe.*
// ---------------------------------------------------------------------------

export interface TranscribeModel {
  id: string;
  repo: string;
  size_bytes?: number;
  installed: boolean;
  device: "cpu" | "cuda";
}

export interface TranscribeParams {
  path: string;
  start_s?: number;
  end_s?: number;
  model_id?: string;
  language?: string;
  device?: "cpu" | "cuda";
}

export interface TranscribeSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob?: number | null;
  no_speech_prob?: number | null;
}

export interface TranscribeResult {
  text: string;
  language: string;
  language_probability: number;
  segments: TranscribeSegment[];
  /** Duration-weighted mean token probability, 0..1 (heuristic); null when the model reported none. */
  confidence?: number | null;
  model_id: string;
  device: "cpu" | "cuda";
  duration_s: number;
  elapsed_s: number;
}

// ---------------------------------------------------------------------------
// engine.* + Capabilities
// ---------------------------------------------------------------------------

export interface Language {
  code: string;
  label: string;
  engine_value: string;
}

export interface ReferenceRequirements {
  needs_transcript: boolean;
  min_seconds: number;
  max_seconds: number;
  recommended_seconds: [number, number];
  sample_rate: number;
  channels: number;
  notes: string;
}

export type ControlType = "float" | "int" | "bool" | "enum";

export interface ControlOption {
  value: string | number | boolean;
  label: string;
}

/** A control the engine adapter declared. The UI renders only what appears here. */
export interface ControlSpec {
  id: string;
  label: string;
  type: ControlType;
  default: unknown;
  min?: number | null;
  max?: number | null;
  step?: number | null;
  options?: ControlOption[] | null;
  description?: string;
  advanced?: boolean;
}

export interface TagSpec {
  token: string;
  label: string;
  description?: string;
}

export interface Capabilities {
  id: string;
  name: string;
  version: string;
  model_id: string;
  model_repo?: string;
  output_sample_rate: number;
  languages: Language[];
  reference: ReferenceRequirements;
  controls: ControlSpec[];
  tags: TagSpec[];
  max_chars_per_request: number;
  supports_cancel: boolean;
  supports_seed: boolean;
  supports_reusable_prompt: boolean;
  supports_multi_reference?: boolean;
  watermark: string | null;
  post_processing: ControlSpec[];
  cancel_granularity: "segment" | "token";
  device?: string;
  notes?: string;
  license?: string;
}

export interface EngineInfo {
  id: string;
  name: string;
  installed: boolean;
  state: EngineLoadState;
  model_state: ModelState;
  model_id?: string | null;
  revision?: string | null;
  vram_bytes?: number | null;
  message?: string;
  optional?: boolean;
  description?: string;
  env?: string;
  env_probe?: Partial<EngineEnvProbe>;
  capabilities?: Capabilities;
}

export interface EngineListResult {
  engines: EngineInfo[];
}

export interface EngineIdParams {
  engine_id: string;
}

export interface EngineLoadParams {
  engine_id: string;
  model_id?: string;
}

export interface EngineLoadResult {
  engine_id: string;
  model_id: string;
  revision: string | null;
  load_ms?: number;
  vram_bytes?: number | null;
  already_loaded?: boolean;
}

export interface EnginePrepareReferenceParams {
  engine_id: string;
  reference_id: string;
}

export interface EnginePrepareReferenceResult {
  prompt_cache_id: string;
  path: string;
  engine_id: string;
  model_revision: string;
  fingerprint: string;
}

/** Values keyed by `ControlSpec.id` from `Capabilities.controls`. */
export type EngineSettings = Record<string, unknown>;

export interface EngineGenerateParams {
  engine_id: string;
  reference_id: string;
  text: string;
  language: string;
  settings: EngineSettings;
  seed?: number | null;
  out_dir: string;
  tag?: string;
}

export interface EngineGenerateResult {
  path: string;
  sample_rate: number;
  duration_s: number;
  seed?: number | null;
  elapsed_s: number;
  normalized_text: string;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// tts.*
// ---------------------------------------------------------------------------

export interface PronunciationRule {
  from: string;
  to: string;
}

export interface TtsPlanOptions {
  max_chars?: number;
  paragraph_pause_ms?: number;
  sentence_pause_ms?: number;
  pronunciation?: PronunciationRule[];
  spell_numbers?: boolean;
}

export interface TtsPlanParams {
  project_id: string;
  script_text: string;
  engine_id: string;
  options?: TtsPlanOptions;
}

export interface Substitution {
  from: string;
  to: string;
  count: number;
}

export interface PlannedSegment {
  index: number;
  paragraph: number;
  text: string;
  normalized_text: string;
  substitutions: Substitution[];
  char_count: number;
  id?: string;
}

export interface TtsPlanResult {
  segments: PlannedSegment[];
  engine_id: string;
  warnings: string[];
}

export interface TtsGenerateParams {
  project_id: string;
  segment_indices?: number[];
  take_label?: string;
  engine_id: string;
  reference_id: string;
  language: string;
  settings: EngineSettings;
  seed?: number | null;
  /** Make a new take for every segment. */
  regenerate_all?: boolean;
  /** Only segments whose selected take was not made with this voice audio, engine, language and controls (Speak). */
  only_changed?: boolean;
}

export interface GeneratedTake {
  segment_index: number;
  take_id: string;
  path: string;
  duration_s: number;
  seed?: number | null;
}

export interface TtsGenerateResult {
  takes: GeneratedTake[];
  skipped: number[] | Array<{ segment_index: number; reason?: string }>;
  elapsed_s: number;
  warnings?: string[];
}

export interface TtsAssembleParams {
  project_id: string;
  take_selection?: Record<number | string, string>;
  paragraph_pause_ms?: number;
  sentence_pause_ms?: number;
}

export interface TtsAssembleResult {
  master_path: string;
  duration_s: number;
  sample_rate: number;
  segments_used: number;
}

export interface TtsCompareEnginesParams {
  project_id: string;
  engine_ids: string[];
  segment_index: number;
}

export interface TtsCompareEnginesResult {
  results: Array<{ engine_id: string; take_id: string; path: string; loudness_matched_preview_path: string }>;
}

// ---------------------------------------------------------------------------
// voices.* / projects.* / library.* / backup.*  (persistence)
// ---------------------------------------------------------------------------

export interface Trim {
  start_s: number;
  end_s: number;
}

export interface DerivedReference {
  path: string;
  sample_rate: number;
  channels: number;
  duration_s: number;
}

export interface Reference {
  id: string;
  voice_id: string;
  asset_id: string;
  label?: string | null;
  start_s: number;
  end_s: number;
  transcript: string;
  transcript_source?: "asr" | "edited";
  transcript_confirmed?: boolean;
  asr_model?: string | null;
  processing?: unknown[];
  fingerprint?: string | null;
  /** engine_id → derived file that matches that engine's requirements */
  derived?: Record<string, DerivedReference>;
  created_at: string;
  /** Source asset summary attached by `voices.*` (repo.reference_dict); null when the asset row is gone. */
  asset?: AssetSummary | null;
}

/** The subset of `Asset` the worker joins onto voice references (`repo.ASSET_SUMMARY_SQL`). */
export type AssetSummary = Pick<Asset, "id" | "kind" | "source" | "original_name" | "original_path" | "working_path" | "duration_s" | "sample_rate" | "channels" | "created_at">;

export interface Asset {
  id: string;
  kind: "reference" | "other";
  source: "import" | "recording";
  original_name?: string | null;
  original_path: string;
  working_path?: string | null;
  sha256?: string | null;
  format?: string | null;
  codec?: string | null;
  duration_s?: number | null;
  sample_rate?: number | null;
  channels?: number | null;
  bit_depth?: number | null;
  size_bytes?: number | null;
  stats?: AudioStats | null;
  created_at: string;
}

export interface Voice {
  id: string;
  name: string;
  tags: string[];
  language: string;
  rights_confirmed: boolean;
  rights_note?: string | null;
  selected_reference_id?: string | null;
  notes?: string | null;
  favorite: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
  references?: Reference[];
  used_by_projects?: number;
}

export interface VoiceCreateParams {
  name: string;
  tags: string[];
  language: string;
  rights_confirmed: true;
  asset_id: string;
  trim: Trim;
  transcript: string;
  engine_id?: string;
  processing?: unknown[];
  transcript_source?: string;
  transcript_confirmed?: boolean;
  asr_model?: string | null;
  label?: string | null;
}

export interface VoicesListResult {
  voices: Voice[];
}

export interface VoiceUpdateParams {
  id: string;
  patch: Partial<Pick<Voice, "name" | "tags" | "language" | "notes" | "favorite" | "archived" | "rights_note">>;
}

export interface VoiceDeleteParams {
  id: string;
  force?: boolean;
}

/** Advanced: export a voice's reviewed recordings as a Qwen3-TTS fine-tuning dataset (data only; no training). */
export interface DatasetExportParams {
  voice_id: string;
  out_dir: string;
  reference_id?: string;
  min_seconds?: number;
  max_seconds?: number;
}
export interface DatasetExportResult {
  path: string;
  jsonl: string;
  samples: number;
  skipped: Array<{ reference_id: string; reason: string }>;
  reference: string;
  total_seconds: number;
}

export interface DatasetPreflightParams {
  params?: number;
  batch?: number;
  seq?: number;
}

export interface DatasetPreflightResult {
  gpu: string;
  vram_total_gb: number;
  vram_free_gb: number;
  estimate_gb: Record<string, number>;
  host_ram_peak_gb: number;
  host_ram_free_gb: number | null;
  fits: boolean;
  verdict: string;
}

export interface EngineHealthResult {
  alive: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface AddReferenceParams {
  voice_id: string;
  asset_id: string;
  trim: Trim;
  transcript: string;
  /** Validates the trim against that engine's reference limits (as `voices.create` does). */
  engine_id?: string;
  processing?: unknown[];
  label?: string | null;
  select?: boolean;
  transcript_source?: string;
  transcript_confirmed?: boolean;
  asr_model?: string | null;
}

export interface SelectReferenceParams {
  voice_id: string;
  reference_id: string;
}

export interface UpdateReferenceParams {
  reference_id: string;
  patch: Partial<{
    transcript: string;
    label: string | null;
    trim: Trim;
    processing: unknown[];
    transcript_confirmed: boolean;
    transcript_source: string;
    asr_model: string | null;
  }>;
}

export interface Take {
  id: string;
  segment_id: string;
  project_id: string;
  engine_id: string;
  model_revision?: string | null;
  reference_id?: string | null;
  path: string;
  sample_rate?: number | null;
  duration_s?: number | null;
  seed?: number | null;
  settings?: Record<string, unknown>;
  label?: string | null;
  status: "ok" | "failed";
  created_at: string;
}

export interface Segment {
  id: string;
  project_id: string;
  plan_version: number;
  /** Position in the plan (the DB column is `idx`; `repo.segment_dict` renames it). */
  index: number;
  paragraph: number;
  text: string;
  normalized_text: string;
  substitutions: Substitution[];
  char_count: number;
  selected_take_id?: string | null;
  created_at?: string;
  takes: Take[];
}

export interface ExportRecord {
  id: string;
  project_id: string;
  path: string;
  format: string;
  settings?: Record<string, unknown>;
  probe?: AudioProbe | null;
  loudness?: LoudnessMeasured | null;
  size_bytes?: number | null;
  created_at: string;
}

export interface MasterInfo {
  duration_s?: number;
  sample_rate?: number;
  segments_used?: number;
  [key: string]: unknown;
}

export interface Project {
  id: string;
  name: string;
  folder: string;
  tags: string[];
  favorite: boolean;
  archived: boolean;
  voice_id?: string | null;
  reference_id?: string | null;
  engine_id?: string | null;
  language: string;
  settings: Record<string, unknown>;
  plan_version: number;
  master_path?: string | null;
  master?: MasterInfo | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
  /** Present on `projects.list` / `projects.get` rows (jobs/projects.py `_summary` / `project_view`). */
  voice_name?: string | null;
  /** Summary fields of `projects.list` rows only. */
  script_excerpt?: string;
  script_version?: number;
  segment_count?: number;
  generated_count?: number;
  has_master?: boolean;
}

/** Latest script as `projects.get` returns it (`updated_at` is the version's creation time). */
export interface ScriptVersion {
  text: string;
  version: number;
  updated_at?: string;
}

/** `projects.get` → `{project, script, segments (current plan, with takes), exports}` (jobs/projects.py `project_view`). */
export interface ProjectDetail {
  project: Project;
  script: ScriptVersion | null;
  segments: Segment[];
  exports: ExportRecord[];
}

export interface ProjectCreateParams {
  name: string;
  voice_id?: string;
  reference_id?: string;
  engine_id?: string;
  folder?: string;
}

export type ProjectSort = "updated" | "created" | "name";

export interface ProjectsListParams {
  query?: string;
  tags?: string[];
  favorite?: boolean;
  /** `false` (worker default) = active only, `true` = archived only, explicit `null` = both. */
  archived?: boolean | null;
  sort?: ProjectSort;
  limit?: number;
  /** The Speak screen's scratch project is left out unless this is true. */
  include_speak?: boolean;
}

export interface ProjectsListResult {
  projects: Project[];
}

export interface ProjectUpdateParams {
  id: string;
  patch: Partial<Pick<Project, "name" | "folder" | "tags" | "favorite" | "notes" | "voice_id" | "reference_id" | "engine_id" | "language" | "settings">>;
}

export interface ProjectArchiveParams {
  id: string;
  archived: boolean;
}

export interface ProjectDeleteParams {
  id: string;
  confirm: true;
}

export interface SaveScriptParams {
  id: string;
  text: string;
}

export interface SaveScriptResult {
  script_version: number;
}

export interface SelectTakeParams {
  id: string;
  segment_index: number;
  take_id: string;
}

export interface LibrarySearchParams {
  query: string;
  /** The worker excludes archived projects unless this is true. */
  include_archived?: boolean;
  limit?: number;
}

export interface LibrarySearchResult {
  projects: Project[];
  voices: Voice[];
}

export interface LibraryFoldersResult {
  folders: Array<{ name: string; count: number } | string>;
}

export interface LibraryTagsResult {
  tags: Array<{ name: string; count: number } | string>;
}

export interface BackupExportParams {
  project_id: string;
  out_path: string;
}

export interface BackupExportResult {
  path: string;
  size_bytes: number;
}

export interface BackupImportResult {
  project_id: string;
}

// ---------------------------------------------------------------------------
// speak.*  (the Speak screen's scratch project and Recent list — jobs/speak.py)
// ---------------------------------------------------------------------------

/** One finished Speak result; `path` is its own file (never overwritten by the next Speak). */
export interface SpeechEntry {
  id: string;
  project_id: string;
  text: string;
  voice_id: string | null;
  voice_name: string | null;
  engine_id: string | null;
  path: string;
  duration_s: number | null;
  sample_rate: number | null;
  created_at: string;
  /** The audio file is still on disk. */
  exists: boolean;
}

export interface SpeakSession {
  project_id: string;
  text: string;
  script_version: number;
  voice_id: string | null;
  engine_id: string | null;
  language: string;
  settings: Record<string, unknown>;
  history: SpeechEntry[];
}

export interface SpeakRememberParams {
  project_id: string;
  text: string;
  voice_id?: string | null;
  keep?: number;
}

export type SpeakRememberResult = SpeechEntry & { pruned: { takes_removed: number; segments_removed: number; history_removed: number } };

// ---------------------------------------------------------------------------
// audio.suggest_reference (automatic reference selection)
// ---------------------------------------------------------------------------

/** A heuristic finding about a voice sample. `block` = the sample cannot be used as it is. */
export interface SampleIssue {
  code: "NO_SPEECH" | "TOO_SHORT" | "TOO_QUIET" | "CLIPPING" | "NOISY" | "MOSTLY_SILENT" | "SHORT" | string;
  message: string;
  severity: "warn" | "block";
  heuristic: true;
}

export interface SuggestReferenceParams {
  path?: string;
  asset_id?: string;
  engine_id?: string;
}

export interface SuggestReferenceResult {
  start_s: number;
  end_s: number;
  duration_s: number;
  /** A phrase-aligned section with clean edges and enough speech was found. */
  reliable: boolean;
  edges_clean: boolean;
  speech_ratio: number;
  speech_s: number;
  total_s: number;
  snr_db: number;
  peak_dbfs: number;
  issues: SampleIssue[];
  recommended_seconds: [number, number];
  min_seconds: number;
  max_seconds: number;
  engine_id: string;
  path: string;
}

// ---------------------------------------------------------------------------
// export.*
// ---------------------------------------------------------------------------

export type ExportFormat = "wav" | "flac" | "mp3";
/** Ids of `export.loudness_targets` (audio/export.py LOUDNESS_TARGETS). */
export type LoudnessTargetId = "podcast-16" | "streaming-14" | "broadcast-r128-23";

export interface ExportRenderParams {
  project_id: string;
  master_path?: string;
  format: ExportFormat;
  out_path: string;
  wav_bit_depth?: 16 | 24 | "32f";
  sample_rate?: "native" | 48000;
  mp3_bitrate_kbps?: 128 | 192 | 256 | 320;
  mp3_vbr_quality?: number;
  loudness?: { target_id: LoudnessTargetId };
  ai_metadata?: boolean;
}

export interface LoudnessMeasured {
  integrated_lufs: number;
  true_peak_dbtp: number;
  lra: number;
}

export interface ExportRenderResult {
  path: string;
  size_bytes: number;
  probe: AudioProbe;
  loudness_measured?: LoudnessMeasured;
  collision_renamed?: boolean;
}

export interface LoudnessTarget {
  id: LoudnessTargetId;
  label: string;
  integrated_lufs: number;
  true_peak_dbtp: number;
  lra: number;
  description: string;
}

export interface LoudnessTargetsResult {
  targets: LoudnessTarget[];
}

// ---------------------------------------------------------------------------
// models.*
// ---------------------------------------------------------------------------

export type ModelKind = "tts" | "asr";

export interface ModelInfo {
  id: string;
  engine_id?: string | null;
  kind: ModelKind;
  repo: string;
  revision_pinned: string | null;
  revision_installed?: string | null;
  size_bytes?: number | null;
  approx_size_bytes?: number | null;
  license: string;
  license_url?: string;
  state: ModelState;
  path?: string | null;
  error?: string | null;
  description?: string;
  companions?: string[];
  bytes_done?: number;
  bytes_total?: number;
}

export interface ModelsListResult {
  models: ModelInfo[];
}

export interface ModelIdParams {
  model_id: string;
}

export interface ModelDownloadResult {
  model_id: string;
  path: string;
  revision: string;
  size_bytes: number;
}

export interface ModelVerifyResult {
  ok: boolean;
  missing_files: string[];
  revision: string | null;
}

export interface ModelUseExistingDirParams {
  model_id: string;
  path: string;
}

export interface ModelUseExistingDirResult {
  ok: boolean;
  revision?: string | null;
  warnings: string[];
}

export interface ModelRemoveParams {
  model_id: string;
  confirm: true;
}

// ---------------------------------------------------------------------------
// Method table: name → params / result. Used for typed `request()` and the api helpers.
// ---------------------------------------------------------------------------

export interface Methods {
  "system.ping": { params: Record<string, never>; result: PingResult };
  "system.diagnostics": { params: Record<string, never>; result: Diagnostics };
  "system.cuda_smoke_test": { params: CudaSmokeParams; result: CudaSmokeResult };
  "system.gpu_status": { params: Record<string, never>; result: GpuStatus };
  "system.set_offline": { params: { offline: boolean }; result: { offline: boolean } };
  "system.settings.get": { params: Record<string, never>; result: Settings };
  "system.settings.set": { params: { patch: SettingsPatch }; result: Settings };
  "system.storage_usage": { params: Record<string, never>; result: StorageUsage };
  "system.clear_cache": { params: { kinds: CacheKind[] }; result: { freed_bytes: number } };
  "system.log_bundle": { params: Record<string, never>; result: { path: string } };

  "audio.probe": { params: { path: string }; result: AudioProbe };
  "audio.import": { params: AudioImportParams; result: AudioImportResult };
  "audio.peaks": { params: AudioPeaksParams; result: AudioPeaksResult };
  "audio.stats": { params: AudioStatsParams; result: AudioStats };
  "audio.trim": { params: AudioTrimParams; result: AudioTrimResult };
  "audio.prepare_reference": { params: PrepareReferenceParams; result: PrepareReferenceResult };
  "audio.preview_processing": { params: PreviewProcessingParams; result: { path: string } };
  "audio.play_device_test": { params: PlayDeviceTestParams; result: { ok: boolean } };
  "audio.suggest_reference": { params: SuggestReferenceParams; result: SuggestReferenceResult };

  "record.devices": { params: Record<string, never>; result: RecordDevicesResult };
  "record.start": { params: RecordStartParams; result: RecordStartResult };
  "record.pause": { params: RecordSessionParams; result: RecordPauseResult };
  "record.resume": { params: RecordSessionParams; result: RecordPauseResult };
  "record.stop": { params: RecordSessionParams; result: RecordStopResult };
  "record.discard": { params: RecordSessionParams; result: { ok: boolean } };
  "record.scripts": { params: Record<string, never>; result: { scripts: RecordScript[] } };

  "transcribe.models": { params: Record<string, never>; result: { models: TranscribeModel[] } };
  "transcribe.run": { params: TranscribeParams; result: TranscribeResult };
  "transcribe.unload": { params: Record<string, never>; result: { ok: boolean } };

  "engine.list": { params: Record<string, never>; result: EngineListResult };
  "engine.capabilities": { params: EngineIdParams; result: Capabilities };
  "engine.load": { params: EngineLoadParams; result: EngineLoadResult };
  "engine.unload": { params: EngineIdParams; result: { ok: boolean } };
  "engine.health": { params: EngineIdParams; result: EngineHealthResult };
  "engine.prepare_reference": { params: EnginePrepareReferenceParams; result: EnginePrepareReferenceResult };
  "engine.generate": { params: EngineGenerateParams; result: EngineGenerateResult };

  "tts.plan": { params: TtsPlanParams; result: TtsPlanResult };
  "tts.generate": { params: TtsGenerateParams; result: TtsGenerateResult };
  "tts.assemble": { params: TtsAssembleParams; result: TtsAssembleResult };
  "tts.compare_engines": { params: TtsCompareEnginesParams; result: TtsCompareEnginesResult };

  "voices.create": { params: VoiceCreateParams; result: Voice };
  "voices.list": { params: Record<string, never>; result: VoicesListResult };
  "voices.get": { params: { id: string }; result: Voice };
  "voices.update": { params: VoiceUpdateParams; result: Voice };
  "voices.delete": { params: VoiceDeleteParams; result: { ok: boolean } };
  "voices.add_reference": { params: AddReferenceParams; result: Reference };
  "voices.update_reference": { params: UpdateReferenceParams; result: Reference };
  "dataset.export": { params: DatasetExportParams; result: DatasetExportResult };
  "dataset.preflight": { params: DatasetPreflightParams; result: DatasetPreflightResult };
  "voices.select_reference": { params: SelectReferenceParams; result: Voice | { ok: boolean } };

  "projects.create": { params: ProjectCreateParams; result: Project };
  "projects.list": { params: ProjectsListParams; result: ProjectsListResult };
  "projects.get": { params: { id: string }; result: ProjectDetail };
  "projects.update": { params: ProjectUpdateParams; result: Project };
  "projects.duplicate": { params: { id: string }; result: Project };
  "projects.archive": { params: ProjectArchiveParams; result: Project | { ok: boolean } };
  "projects.delete": { params: ProjectDeleteParams; result: { ok: boolean } };
  "projects.save_script": { params: SaveScriptParams; result: SaveScriptResult };
  "projects.select_take": { params: SelectTakeParams; result: { ok: boolean } };

  "speak.session": { params: { history_limit?: number }; result: SpeakSession };
  "speak.history": { params: { limit?: number }; result: { history: SpeechEntry[] } };
  "speak.remember": { params: SpeakRememberParams; result: SpeakRememberResult };
  "speak.forget": { params: { id: string }; result: { ok: boolean } };

  "library.search": { params: LibrarySearchParams; result: LibrarySearchResult };
  "library.folders": { params: Record<string, never>; result: LibraryFoldersResult };
  "library.tags": { params: Record<string, never>; result: LibraryTagsResult };

  "backup.export": { params: BackupExportParams; result: BackupExportResult };
  "backup.import": { params: { path: string }; result: BackupImportResult };

  "export.render": { params: ExportRenderParams; result: ExportRenderResult };
  "export.loudness_targets": { params: Record<string, never>; result: LoudnessTargetsResult };

  "models.list": { params: Record<string, never>; result: ModelsListResult };
  "models.state": { params: ModelIdParams; result: ModelInfo };
  "models.download": { params: ModelIdParams; result: ModelDownloadResult };
  "models.cancel_download": { params: ModelIdParams; result: { ok: boolean } };
  "models.verify": { params: ModelIdParams; result: ModelVerifyResult };
  "models.use_existing_dir": { params: ModelUseExistingDirParams; result: ModelUseExistingDirResult };
  "models.remove": { params: ModelRemoveParams; result: { ok: boolean } };
}

export type MethodName = keyof Methods;
export type ParamsOf<M extends MethodName> = Methods[M]["params"];
export type ResultOf<M extends MethodName> = Methods[M]["result"];

// ---------------------------------------------------------------------------
// Rust shell commands (src-tauri/src/commands.rs)
// ---------------------------------------------------------------------------

export interface AppPathsInfo {
  data: string;
  config: string;
  cache: string;
  models?: string;
  logs?: string;
  [key: string]: string | undefined;
}

/** `runtime_status()` — mirrors the Rust `RuntimeStatus` struct (src-tauri/src/commands.rs). */
export interface RuntimeStatus {
  python: string;
  pythonpath: string;
  mode: "dev" | "managed";
  found: boolean;
  python_found: boolean;
  package_found: boolean;
  source: "env" | "dev-venv" | "managed";
  runtime_root: string;
  bootstrap_script: string;
  bootstrap_script_found: boolean;
  bootstrap_running: boolean;
  standalone: boolean;
}

/** Arguments of `runtime_bootstrap` (Tauri maps camelCase onto the snake_case Rust parameters). */
export interface RuntimeBootstrapArgs {
  /** `--with-chatterbox` / `--without-chatterbox`; the script's own default when omitted. */
  withChatterbox?: boolean;
  /** Sets `SFVS_AUTO_INSTALL_UV=1` so the script may download `uv` when it is missing. */
  autoInstallUv?: boolean;
}

/** One `runtime://log` line; `stream` is "stdout" | "stderr" | "system". */
export interface RuntimeLogLine {
  line: string;
  stream?: string;
}

export interface PickSavePathParams {
  defaultName: string;
  ext: string;
}

/** Named shell commands with their argument/return shapes. */
export interface ShellCommands {
  worker_request: { args: { id?: string; method: string; params: unknown }; result: unknown };
  worker_cancel: { args: { id: string }; result: void };
  worker_status: { args: Record<string, never>; result: WorkerStatus };
  worker_restart: { args: Record<string, never>; result: void };
  app_paths: { args: Record<string, never>; result: AppPathsInfo };
  runtime_status: { args: Record<string, never>; result: RuntimeStatus };
  /** Resolves with the script's exit code (0); a non-zero exit rejects with a `WorkerError`. */
  runtime_bootstrap: { args: RuntimeBootstrapArgs; result: number };
  pick_audio_files: { args: Record<string, never>; result: string[] | null };
  pick_text_file: { args: Record<string, never>; result: string | null };
  pick_save_path: { args: PickSavePathParams; result: string | null };
  pick_archive_file: { args: Record<string, never>; result: string | null };
  pick_directory: { args: Record<string, never>; result: string | null };
  read_text_file: { args: { path: string }; result: string };
  open_path: { args: { path: string }; result: void };
  reveal_path: { args: { path: string }; result: void };
}
export type ShellCommandName = keyof ShellCommands;

/** Tauri event channels emitted by the shell. */
export interface ShellEvents {
  "worker://progress": Progress;
  "worker://event": { event: WorkerEventName | string; data: unknown };
  "worker://status": WorkerStatus;
  "runtime://log": RuntimeLogLine;
}
export type ShellEventName = keyof ShellEvents;
