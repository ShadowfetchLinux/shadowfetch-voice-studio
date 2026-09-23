/**
 * PREVIEW MOCK — an explicit, obviously fake transport used ONLY when the UI is opened in a plain
 * browser during `vite dev` (no Tauri runtime). Never bundled into the desktop app's code path:
 * api.ts only imports this module behind `import.meta.env.DEV && !isTauri()`.
 *
 * Every string it produces is labelled "(mock)" so nothing here can be mistaken for real data.
 * It exists so the shell, design system and pages can be previewed and smoke-tested without hardware.
 */
import type { Transport } from "./api";
import type {
  Capabilities,
  Diagnostics,
  EngineInfo,
  ModelInfo,
  Progress,
  Project,
  Reference,
  RuntimeStatus,
  Settings,
  SpeechEntry,
  StorageUsage,
  Voice,
  WorkerErrorShape,
  WorkerStatus,
} from "./protocol";

if (!import.meta.env.DEV) {
  throw new Error("devmock.ts must never be loaded outside development");
}

const MOCK = "(mock)";

type Listener = (payload: unknown) => void;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A playable "speech-like" WAV as a data: URL (8 kHz, 8-bit): tone bursts with pauses, so players, scrubbers and the
 * waveform work in the browser preview. It is obviously synthetic — nothing is generated from text.
 */
function mockWav(seconds: number, seed = 1): string {
  const sr = 8000;
  const n = Math.max(1, Math.round(seconds * sr));
  const bytes = new Uint8Array(44 + n);
  const dv = new DataView(bytes.buffer);
  const str = (o: number, t: string) => [...t].forEach((c, i) => (bytes[o + i] = c.charCodeAt(0)));
  str(0, "RIFF");
  dv.setUint32(4, 36 + n, true);
  str(8, "WAVEfmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr, true);
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true);
  str(36, "data");
  dv.setUint32(40, n, true);
  const f = 140 + 30 * (seed % 5);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const phrase = (t % 2.6) < 2.1 ? 1 : 0; // ~2 s phrases, 0.5 s pauses
    const env = phrase * (0.55 + 0.45 * Math.abs(Math.sin(2 * Math.PI * 3 * t)));
    bytes[44 + i] = 128 + Math.round(60 * env * Math.sin(2 * Math.PI * f * t));
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:audio/wav;base64,${btoa(bin)}`;
}

/** Min/max envelope of `mockWav` for the waveform. */
function mockPeaks(seconds: number, points = 800): Array<[number, number]> {
  return Array.from({ length: points }, (_, i) => {
    const t = (i / points) * seconds;
    const a = (t % 2.6) < 2.1 ? 0.25 + 0.2 * Math.abs(Math.sin(2 * Math.PI * 3 * t)) : 0.01;
    return [-a, a];
  });
}

function fail(code: WorkerErrorShape["code"], message: string, details: Record<string, unknown> = {}, recoverable = true): never {
  // Thrown as the plain object shape the Rust command would reject with.
  throw { code, message: `${message} ${MOCK}`, details, recoverable } satisfies WorkerErrorShape;
}

const defaultSettings: Settings = {
  offline: false,
  models_dir: "",
  default_engine: "qwen3-tts-base",
  default_language: "en",
  asr_model: "faster-whisper-small.en",
  asr_device: "cpu",
  gpu_jobs: 1,
  idle_unload_minutes: 15,
  record_sample_rate: 48000,
  record_subtype: "PCM_24",
  record_device_index: null,
  output_device_index: null,
  monitor_input: false,
  max_chars_per_segment: 400,
  paragraph_pause_ms: 600,
  sentence_pause_ms: 250,
  export_default_format: "wav",
  export_wav_bit_depth: 24,
  export_mp3_bitrate_kbps: 192,
  export_ai_metadata: true,
  redact_logs: true,
  onboarding_done: false,
  rights_notice_accepted: false,
  engine_settings: {},
  extra: {},
};

const qwenCaps: Capabilities = {
  id: "qwen3-tts-base",
  name: `Qwen3-TTS 1.7B Base ${MOCK}`,
  version: "0.0.0-mock",
  model_id: "qwen3-tts-12hz-1.7b-base",
  model_repo: "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
  output_sample_rate: 24000,
  languages: [
    { code: "en", label: "English", engine_value: "English" },
    { code: "de", label: "German", engine_value: "German" },
  ],
  reference: {
    needs_transcript: true,
    min_seconds: 3,
    max_seconds: 30,
    recommended_seconds: [8, 15],
    sample_rate: 24000,
    channels: 1,
    notes: `Preview mock capabilities — not from a real adapter ${MOCK}`,
  },
  controls: [
    { id: "temperature", label: "Sampling temperature", type: "float", min: 0.1, max: 1.5, step: 0.05, default: 0.9, description: "mock control", advanced: true },
  ],
  tags: [],
  max_chars_per_request: 400,
  supports_cancel: true,
  supports_seed: true,
  supports_reusable_prompt: true,
  watermark: null,
  post_processing: [{ id: "speed", label: "Speed (post-processing)", type: "float", min: 0.8, max: 1.25, step: 0.01, default: 1.0 }],
  cancel_granularity: "segment",
  device: "cuda",
  license: "Apache-2.0",
};

interface MockAsset {
  id: string;
  path: string;
  seconds: number;
}

interface MockState {
  settings: Settings;
  engines: EngineInfo[];
  models: ModelInfo[];
  projects: Project[];
  status: WorkerStatus;
  downloads: Map<string, { cancelled: boolean }>;
  voices: Voice[];
  assets: Map<string, MockAsset>;
  speak: { projectId: string; text: string; voiceId: string | null; settings: Record<string, unknown>; history: SpeechEntry[]; lastText: string };
  cancelled: Set<string>;
  recording: { sessionId: string; started: number; timer: number } | null;
}

/** `?fresh` in the preview URL starts with no voices and no models (first run). */
function freshRun(): boolean {
  try {
    return new URLSearchParams(window.location.search).has("fresh");
  } catch {
    return false;
  }
}

let mockSeq = 0;
function mockId(prefix: string): string {
  mockSeq += 1;
  return `${prefix}_mock${mockSeq}${Math.random().toString(16).slice(2, 6)}`;
}

function mockVoice(name: string, seconds: number, seed: number, assets: Map<string, MockAsset>, daysAgo = 0): Voice {
  const created = new Date(Date.now() - daysAgo * 86400_000).toISOString();
  const asset: MockAsset = { id: mockId("asset"), path: mockWav(seconds + 4, seed), seconds: seconds + 4 };
  assets.set(asset.id, asset);
  const vid = mockId("voice");
  const ref: Reference = {
    id: mockId("ref"), voice_id: vid, asset_id: asset.id, label: null, start_s: 1.2, end_s: 1.2 + seconds,
    transcript: `Preview transcript ${MOCK}`, transcript_source: "asr", transcript_confirmed: false, created_at: created,
    asset: { id: asset.id, kind: "reference", source: "import", original_name: "sample.wav", original_path: asset.path, working_path: asset.path, duration_s: asset.seconds, sample_rate: 8000, channels: 1, created_at: created },
  };
  return { id: vid, name, tags: [], language: "en", rights_confirmed: true, notes: MOCK, selected_reference_id: ref.id, favorite: false, archived: false, created_at: created, updated_at: created, references: [ref] };
}

function initialState(): MockState {
  const now = new Date().toISOString();
  const fresh = freshRun();
  const assets = new Map<string, MockAsset>();
  const voices = fresh ? [] : [mockVoice("Bob", 11.8, 1, assets, 3), mockVoice("Sarah", 13.4, 2, assets, 12), mockVoice("Narrator", 9.6, 3, assets, 40)];
  return {
    assets,
    voices,
    cancelled: new Set(),
    recording: null,
    speak: { projectId: "proj_speak_mock", text: "", voiceId: voices[0]?.id ?? null, settings: {}, history: [], lastText: "" },
    settings: { ...defaultSettings, speak_autoplay: true, speak_project_id: "proj_speak_mock", onboarding_done: !fresh },
    status: { running: true, restarts: 0, last_error: null, stopped: false },
    downloads: new Map(),
    engines: [
      { id: "qwen3-tts-base", name: `Qwen3-TTS 1.7B Base ${MOCK}`, installed: true, state: "unloaded", model_state: "missing", optional: false, capabilities: qwenCaps },
      { id: "chatterbox-turbo", name: `Chatterbox-Turbo ${MOCK}`, installed: false, state: "unloaded", model_state: "missing", optional: true },
    ],
    models: [
      { id: "qwen3-tts-12hz-1.7b-base", engine_id: "qwen3-tts-base", kind: "tts", repo: "Qwen/Qwen3-TTS-12Hz-1.7B-Base", revision_pinned: "fd4b254389122332181a7c3db7f27e918eec64e3", size_bytes: null, approx_size_bytes: 4_540_000_000, license: "Apache-2.0", license_url: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base", state: fresh ? "missing" : "installed", description: `Primary engine ${MOCK}` },
      { id: "chatterbox-turbo", engine_id: "chatterbox-turbo", kind: "tts", repo: "ResembleAI/chatterbox-turbo", revision_pinned: null, size_bytes: null, approx_size_bytes: 1_200_000_000, license: "MIT (code) / see model card (weights)", license_url: "https://huggingface.co/ResembleAI/chatterbox-turbo", state: "missing", description: `Optional secondary engine ${MOCK}` },
      { id: "faster-whisper-small.en", kind: "asr", repo: "Systran/faster-whisper-small.en", revision_pinned: null, size_bytes: null, approx_size_bytes: 490_000_000, license: "MIT", state: fresh ? "missing" : "installed", description: `English transcription ${MOCK}` },
      { id: "faster-whisper-base.en", kind: "asr", repo: "Systran/faster-whisper-base.en", revision_pinned: null, size_bytes: null, approx_size_bytes: 150_000_000, license: "MIT", state: "missing", description: `Smaller transcription ${MOCK}` },
    ],
    projects: [1, 2, 3].map((n) => ({
      id: `mockproj${n}`,
      name: `Preview project ${n} ${MOCK}`,
      folder: "",
      tags: ["mock"],
      favorite: n === 1,
      archived: false,
      voice_id: null,
      reference_id: null,
      engine_id: "qwen3-tts-base",
      language: "en",
      settings: {},
      plan_version: 0,
      master_path: null,
      created_at: now,
      updated_at: new Date(Date.now() - n * 3600_000).toISOString(),
      voice_name: `Mock voice ${n} ${MOCK}`,
    })),
  };
}

function mockDiagnostics(s: MockState): Diagnostics {
  return {
    os: { system: "Linux", release: "mock", machine: "x86_64", pretty: `Preview mock OS ${MOCK}` },
    cpu: { name: `Mock CPU ${MOCK}`, threads: 8 },
    ram: { total_bytes: 32 * 2 ** 30, available_bytes: 20 * 2 ** 30 },
    gpus: [{ index: 0, name: `Mock GPU ${MOCK}`, driver: "0.0", vram_total_bytes: 16 * 2 ** 30, vram_used_bytes: 1 * 2 ** 30, utilization_pct: 3 }],
    disk: { path: "/mock/data", free_bytes: 120 * 2 ** 30, total_bytes: 512 * 2 ** 30 },
    ffmpeg: { path: "/mock/bin/ffmpeg", version: "mock" },
    ffprobe: { path: "/mock/bin/ffprobe", version: "mock" },
    python: {
      main: { version: "3.12 (mock)", path: "/mock/python" },
      engines: {
        main: { installed: true, python: "3.12 (mock)", torch: "mock", cuda_available: true, cuda_device: `Mock GPU ${MOCK}` },
        chatterbox: { installed: false, error: "environment not installed (mock)" },
      },
    },
    audio: {
      inputs: [{ index: 0, name: `Mock microphone ${MOCK}`, hostapi: "mock", max_input_channels: 2, max_output_channels: 0, default_samplerate: 48000 }],
      outputs: [{ index: 1, name: `Mock speakers ${MOCK}`, hostapi: "mock", max_input_channels: 0, max_output_channels: 2, default_samplerate: 48000 }],
      default_input: 0,
      default_output: 1,
    },
    offline: s.settings.offline,
    data_dir: "/mock/data",
    models_dir: "/mock/data/models",
    warnings: [`This is the browser preview mock — nothing here reflects your machine ${MOCK}`],
  };
}

/** Build a mock transport. One instance per page load; state lives in memory only. */
export function createMockTransport(): Transport {
  const state = initialState();
  const listeners = new Map<string, Set<Listener>>();
  console.info("%cShadowfetch Voice Studio — PREVIEW MOCK transport active (not inside Tauri)", "color:#b45309;font-weight:bold");

  const emit = (channel: string, payload: unknown) => {
    for (const l of listeners.get(channel) ?? []) l(payload);
  };
  const progress = (id: string, p: Omit<Progress, "id">) => emit("worker://progress", { id, ...p });
  const event = (name: string, data: unknown) => emit("worker://event", { event: name, data });

  const modelById = (id: string) => state.models.find((m) => m.id === id) ?? fail("NOT_FOUND", `Unknown model ${id}`);
  const engineById = (id: string) => state.engines.find((e) => e.id === id) ?? fail("ENGINE_UNAVAILABLE", `Unknown engine ${id}`);
  const syncEngineModelState = () => {
    for (const e of state.engines) {
      const m = state.models.find((x) => x.engine_id === e.id);
      if (m) e.model_state = m.state;
    }
  };

  async function dispatch(id: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    await delay(60 + Math.random() * 120);
    switch (method) {
      case "system.ping":
        return { ok: true, uptime_s: performance.now() / 1000 };
      case "system.diagnostics":
        return mockDiagnostics(state);
      case "system.gpu_status":
        return { gpus: mockDiagnostics(state).gpus, engines: Object.fromEntries(state.engines.map((e) => [e.id, { engine_id: e.id, state: e.state, model_id: e.model_id ?? null, vram_bytes: e.vram_bytes ?? null }])) };
      case "system.cuda_smoke_test":
        progress(id, { stage: "cuda", message: "Running a mock matmul" });
        await delay(600);
        return { ok: true, device: `Mock GPU ${MOCK}`, torch_version: "mock", cuda_version: "mock", matmul_ms: 0 };
      case "system.set_offline":
        state.settings.offline = Boolean(params.offline);
        return { offline: state.settings.offline };
      case "system.settings.get":
        return { ...state.settings };
      case "system.settings.set":
        Object.assign(state.settings, (params.patch as Partial<Settings>) ?? {});
        return { ...state.settings };
      case "system.storage_usage":
        return {
          data_dir: "/mock/data",
          models_bytes: state.models.filter((m) => m.state === "installed").reduce((a, m) => a + (m.approx_size_bytes ?? 0), 0),
          recordings_bytes: 0,
          voices_bytes: 0,
          projects_bytes: 0,
          exports_bytes: 0,
          cache_bytes: 0,
          free_bytes: 120 * 2 ** 30,
          total_bytes: 512 * 2 ** 30,
        } satisfies StorageUsage;
      case "system.clear_cache":
        return { freed_bytes: 0 };
      case "system.log_bundle":
        return { path: "/mock/data/exports/diagnostics-mock.zip" };

      case "audio.play_device_test":
        await delay(400);
        return { ok: true };
      case "record.devices":
        return { inputs: mockDiagnostics(state).audio.inputs, default_input: 0 };
      case "transcribe.models":
        return { models: state.models.filter((m) => m.kind === "asr").map((m) => ({ id: m.id, repo: m.repo, size_bytes: m.approx_size_bytes ?? undefined, installed: m.state === "installed", device: "cpu" })) };

      case "engine.list":
        syncEngineModelState();
        return { engines: state.engines.map((e) => ({ ...e })) };
      case "engine.capabilities":
        return engineById(String(params.engine_id)).capabilities ?? fail("ENGINE_UNAVAILABLE", "No capabilities in mock");
      case "engine.load": {
        const e = engineById(String(params.engine_id));
        if (!e.installed) fail("ENGINE_UNAVAILABLE", `Environment for ${e.id} is not installed`);
        const m = state.models.find((x) => x.engine_id === e.id);
        if (!m || m.state !== "installed") fail("MODEL_MISSING", `Model for ${e.id} is not installed`, { model_id: m?.id });
        for (const other of state.engines) {
          if (other.id !== e.id && other.state === "loaded") {
            other.state = "unloaded";
            other.model_id = null;
            other.vram_bytes = null;
            event("engine.state", { engine_id: other.id, state: "unloaded", message: "another engine was requested" });
          }
        }
        e.state = "loading";
        e.model_id = m.id;
        event("engine.state", { engine_id: e.id, state: "loading", model_id: m.id, message: "Loading model weights" });
        progress(id, { stage: "engine", message: "Loading mock weights" });
        await delay(900);
        e.state = "loaded";
        e.vram_bytes = 5 * 2 ** 30;
        e.revision = "mockrev";
        event("engine.state", { engine_id: e.id, state: "loaded", model_id: m.id, vram_bytes: e.vram_bytes, revision: e.revision });
        return { engine_id: e.id, model_id: m.id, revision: e.revision, load_ms: 900, vram_bytes: e.vram_bytes };
      }
      case "engine.unload": {
        const e = engineById(String(params.engine_id));
        e.state = "unloaded";
        e.model_id = null;
        e.vram_bytes = null;
        event("engine.state", { engine_id: e.id, state: "unloaded", message: "" });
        return { ok: true };
      }

      case "models.list":
        return { models: state.models.map((m) => ({ ...m })) };
      case "models.download": {
        const m = modelById(String(params.model_id));
        if (state.settings.offline) fail("OFFLINE_BLOCKED", "Offline mode is on; downloads are blocked");
        if (m.state === "installed") return { model_id: m.id, path: `/mock/models/${m.id}`, revision: "mockrev", size_bytes: m.approx_size_bytes ?? 0 };
        const total = m.approx_size_bytes ?? 1_000_000;
        const token = { cancelled: false };
        state.downloads.set(m.id, token);
        m.state = "downloading";
        event("model.state", { model_id: m.id, state: "downloading", bytes_done: 0, bytes_total: total });
        const steps = 20;
        for (let i = 1; i <= steps; i++) {
          await delay(150);
          if (token.cancelled) {
            m.state = "missing";
            event("model.state", { model_id: m.id, state: "missing", message: "download cancelled" });
            fail("CANCELLED", "Download cancelled", { bytes_done: Math.round((total * (i - 1)) / steps) });
          }
          const done = Math.round((total * i) / steps);
          progress(id, { stage: "download", message: `Downloading ${m.repo}`, current: done, total, detail: { bytes_done: done, bytes_total: total } });
          event("model.state", { model_id: m.id, state: "downloading", bytes_done: done, bytes_total: total });
        }
        state.downloads.delete(m.id);
        m.state = "installed";
        m.size_bytes = total;
        m.revision_installed = "mockrev";
        m.path = `/mock/models/${m.id}`;
        event("model.state", { model_id: m.id, state: "installed" });
        syncEngineModelState();
        return { model_id: m.id, path: m.path, revision: "mockrev", size_bytes: total };
      }
      case "models.cancel_download": {
        const token = state.downloads.get(String(params.model_id));
        if (token) token.cancelled = true;
        return { ok: true };
      }
      case "models.verify": {
        const m = modelById(String(params.model_id));
        await delay(400);
        return { ok: m.state === "installed", missing_files: m.state === "installed" ? [] : ["config.json"], revision: m.revision_installed ?? null };
      }
      case "models.use_existing_dir": {
        const m = modelById(String(params.model_id));
        m.state = "installed";
        m.path = String(params.path);
        m.revision_installed = "local";
        syncEngineModelState();
        return { ok: true, revision: "local", warnings: [`Mock accepted the folder without checking it ${MOCK}`] };
      }
      case "models.remove": {
        const m = modelById(String(params.model_id));
        m.state = "missing";
        m.path = null;
        m.size_bytes = null;
        m.revision_installed = null;
        syncEngineModelState();
        event("model.state", { model_id: m.id, state: "missing" });
        return { ok: true };
      }

      case "projects.list": {
        const limit = typeof params.limit === "number" ? params.limit : undefined;
        const list = [...state.projects].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        return { projects: limit ? list.slice(0, limit) : list };
      }
      case "projects.get":
        fail("NOT_FOUND", `Project detail is not available in the preview mock`);
        break;
      // ---------------------------------------------------------------- voices
      case "voices.list":
        return { voices: state.voices.map((v) => ({ ...v })) };
      case "voices.get":
        return { ...(state.voices.find((v) => v.id === params.id) ?? fail("NOT_FOUND", "voice not found")) };
      case "voices.create": {
        if (params.rights_confirmed !== true) fail("INVALID_PARAMS", "rights_confirmed must be true");
        const asset = state.assets.get(String(params.asset_id)) ?? fail("NOT_FOUND", "asset not found");
        const trim = params.trim as { start_s: number; end_s: number };
        const v = mockVoice(String(params.name), trim.end_s - trim.start_s, state.voices.length + 4, state.assets);
        v.references![0] = { ...v.references![0]!, asset_id: asset.id, start_s: trim.start_s, end_s: trim.end_s, transcript: String(params.transcript), asset: { ...v.references![0]!.asset!, id: asset.id, working_path: asset.path, original_path: asset.path, duration_s: asset.seconds } };
        state.voices.unshift(v);
        return { ...v };
      }
      case "voices.update": {
        const v = state.voices.find((x) => x.id === params.id) ?? fail("NOT_FOUND", "voice not found");
        Object.assign(v, params.patch as Partial<Voice>, { updated_at: new Date().toISOString() });
        return { ...v };
      }
      case "voices.delete":
        state.voices = state.voices.filter((v) => v.id !== params.id);
        if (state.speak.voiceId === params.id) state.speak.voiceId = null;
        return { ok: true };
      case "voices.add_reference": {
        const v = state.voices.find((x) => x.id === params.voice_id) ?? fail("NOT_FOUND", "voice not found");
        const asset = state.assets.get(String(params.asset_id)) ?? fail("NOT_FOUND", "asset not found");
        const trim = params.trim as { start_s: number; end_s: number };
        const base = v.references![0]!;
        const ref: Reference = { ...base, id: mockId("ref"), asset_id: asset.id, start_s: trim.start_s, end_s: trim.end_s, transcript: String(params.transcript), asset: { ...base.asset!, id: asset.id, working_path: asset.path, duration_s: asset.seconds } };
        v.references = [...(v.references ?? []), ref];
        if (params.select) v.selected_reference_id = ref.id;
        return ref;
      }
      case "voices.select_reference": {
        const v = state.voices.find((x) => x.id === params.voice_id) ?? fail("NOT_FOUND", "voice not found");
        v.selected_reference_id = String(params.reference_id);
        return { ...v };
      }
      case "voices.update_reference": {
        for (const v of state.voices) {
          const r = v.references?.find((x) => x.id === params.reference_id);
          if (r) {
            const patch = params.patch as { trim?: { start_s: number; end_s: number }; transcript?: string };
            if (patch.trim) Object.assign(r, patch.trim);
            if (patch.transcript) r.transcript = patch.transcript;
            return { ...r };
          }
        }
        return fail("NOT_FOUND", "reference not found");
      }

      // ---------------------------------------------------------------- audio / record / transcribe
      case "audio.peaks": {
        const asset = [...state.assets.values()].find((a) => a.path === params.path);
        const secs = asset?.seconds ?? 10;
        return { points: 800, duration_s: secs, sample_rate: 8000, peaks: mockPeaks(secs) };
      }
      case "audio.import": {
        progress(id, { stage: "copy", message: "Copying the original file" });
        await delay(500);
        const seconds = 34;
        const a: MockAsset = { id: mockId("asset"), path: mockWav(seconds, 7), seconds };
        state.assets.set(a.id, a);
        return { asset_id: a.id, original_path: a.path, working_path: a.path, probe: { format: "wav", codec: "pcm", duration_s: seconds, sample_rate: 48000, channels: 1, size_bytes: 3_000_000 }, peaks_path: "", stats: { duration_s: seconds, sample_rate: 48000, channels: 1, peak_dbfs: -4, rms_dbfs: -20, clipping_samples: 0, leading_silence_s: 0.4, trailing_silence_s: 0.5, silence_ratio: 0.2, warnings: [] } };
      }
      case "audio.suggest_reference": {
        await delay(500);
        const a = state.assets.get(String(params.asset_id)) ?? fail("NOT_FOUND", "asset not found");
        if (a.seconds < 4) return { start_s: 0, end_s: a.seconds, duration_s: a.seconds, reliable: false, edges_clean: false, speech_ratio: 0.9, speech_s: a.seconds * 0.8, total_s: a.seconds, snr_db: 40, peak_dbfs: -6, issues: [{ code: "TOO_SHORT", message: "too short (mock)", severity: "block", heuristic: true }], recommended_seconds: [8, 15], min_seconds: 3, max_seconds: 30, engine_id: "qwen3-tts-base", path: a.path };
        const start = 2.55;
        const end = Math.min(a.seconds, start + 2.6 * 4 + 2.15);
        return { start_s: start, end_s: end, duration_s: end - start, reliable: true, edges_clean: true, speech_ratio: 0.84, speech_s: a.seconds * 0.8, total_s: a.seconds, snr_db: 42, peak_dbfs: -5, issues: [], recommended_seconds: [8, 15], min_seconds: 3, max_seconds: 30, engine_id: "qwen3-tts-base", path: a.path };
      }
      case "transcribe.run": {
        const asr = state.models.find((m) => m.id === state.settings.asr_model);
        if (asr && asr.state !== "installed") fail("MODEL_MISSING", "The transcription model is not installed", { model_id: asr.id });
        progress(id, { stage: "transcribe", message: "Transcribing" });
        await delay(900);
        if (state.cancelled.has(id)) fail("CANCELLED", "Cancelled");
        return { text: `The birch canoe slid on the smooth planks. Glue the sheet to the dark blue background. ${MOCK}`, language: "en", language_probability: 0.99, segments: [], confidence: 0.91, model_id: state.settings.asr_model, device: "cpu", duration_s: 12, elapsed_s: 0.9 };
      }
      case "record.start": {
        const sessionId = mockId("rec");
        const started = Date.now();
        const timer = window.setInterval(() => {
          const t = (Date.now() - started) / 1000;
          const rms = -24 + 10 * Math.sin(t * 5) * Math.random();
          event("record.level", { session_id: sessionId, peak_dbfs: rms + 8, rms_dbfs: rms, clipped: false, elapsed_s: t, bytes_written: Math.round(t * 144000) });
        }, 100);
        state.recording = { sessionId, started, timer };
        return { session_id: sessionId, path: "/mock/rec.wav", negotiated: { sample_rate: 48000, channels: 1, dtype: "float32", subtype: "PCM_24", hostapi: "mock", device_name: `Mock microphone ${MOCK}`, latency_s: 0.01 }, notes: [], monitoring: false };
      }
      case "record.stop":
      case "record.discard": {
        const r = state.recording;
        if (r) window.clearInterval(r.timer);
        state.recording = null;
        if (method === "record.discard" || !r) return { ok: true };
        const seconds = Math.max(0.5, (Date.now() - r.started) / 1000);
        const a: MockAsset = { id: mockId("asset"), path: mockWav(seconds, 5), seconds };
        state.assets.set(a.id, a);
        return { session_id: r.sessionId, path: a.path, working_path: a.path, asset_id: a.id, duration_s: seconds, stats: null, negotiated: { sample_rate: 48000, channels: 1, dtype: "float32", subtype: "PCM_24", hostapi: "mock", device_name: "mock", latency_s: 0.01 }, notes: [] };
      }

      // ---------------------------------------------------------------- speak / tts
      case "speak.session":
        return { project_id: state.speak.projectId, text: state.speak.text, script_version: 1, voice_id: state.speak.voiceId, engine_id: "qwen3-tts-base", language: "en", settings: state.speak.settings, history: state.speak.history.slice(0, Number(params.history_limit ?? 10)) };
      case "speak.history":
        return { history: state.speak.history.slice(0, Number(params.limit ?? 30)) };
      case "speak.forget":
        state.speak.history = state.speak.history.filter((h) => h.id !== params.id);
        return { ok: true };
      case "projects.save_script":
        if (params.id === state.speak.projectId) state.speak.text = String(params.text);
        return { script_version: 2, changed: true };
      case "projects.update": {
        if (params.id === state.speak.projectId) {
          const patch = params.patch as { voice_id?: string; settings?: Record<string, unknown> };
          if (patch.voice_id !== undefined) state.speak.voiceId = patch.voice_id;
          if (patch.settings) for (const [k, v] of Object.entries(patch.settings)) state.speak.settings[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...(state.speak.settings[k] as object), ...(v as object) } : v;
        }
        return { id: params.id };
      }
      case "tts.plan": {
        const text = String(params.script_text ?? "");
        state.speak.text = text;
        const sentences = text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
        return { segments: sentences.map((t, i) => ({ index: i, paragraph: 0, text: t, normalized_text: t, substitutions: [], char_count: t.length })), engine_id: "qwen3-tts-base", warnings: [] };
      }
      case "tts.generate": {
        const tts = state.models.find((m) => m.kind === "tts" && m.engine_id === "qwen3-tts-base");
        if (tts?.state !== "installed") fail("MODEL_MISSING", "The model qwen3-tts-12hz-1.7b-base is not installed", { model_id: tts?.id });
        const n = Math.max(1, state.speak.text.split(/(?<=[.!?])\s+/).filter((x) => x.trim()).length);
        const eng = state.engines[0]!;
        if (eng.state !== "loaded") {
          progress(id, { stage: "engine", message: "Loading weights" });
          await delay(1200);
          eng.state = "loaded";
        }
        const done: unknown[] = [];
        for (let i = 1; i <= n; i++) {
          if (state.cancelled.has(id)) fail("CANCELLED", "Cancelled", { completed: done });
          progress(id, { stage: "generate", message: `Generating segment ${i} of ${n}`, current: i, total: n, detail: { segment_index: i - 1 } });
          await delay(700);
          done.push({ segment_index: i - 1, take_id: mockId("take"), path: "", duration_s: 2 });
        }
        return { takes: done, skipped: [], elapsed_s: n * 0.7 };
      }
      case "tts.assemble":
        await delay(250);
        return { master_path: "/mock/master.wav", duration_s: 3, sample_rate: 24000, segments_used: 1 };
      case "speak.remember": {
        const text = String(params.text);
        const seconds = Math.max(1.5, Math.min(60, text.length / 15));
        const v = state.voices.find((x) => x.id === params.voice_id);
        const entry: SpeechEntry = { id: mockId("speech"), project_id: state.speak.projectId, text, voice_id: v?.id ?? null, voice_name: v?.name ?? null, engine_id: "qwen3-tts-base", path: mockWav(seconds, state.speak.history.length + 2), duration_s: seconds, sample_rate: 8000, created_at: new Date().toISOString(), exists: true };
        state.speak.history.unshift(entry);
        return { ...entry, pruned: { takes_removed: 0, segments_removed: 0, history_removed: 0 } };
      }
      case "engine.prepare_reference":
        await delay(300);
        return { prompt_cache_id: "mock", path: "/mock", engine_id: "qwen3-tts-base", model_revision: "mockrev", fingerprint: "mock" };
      case "export.render":
        await delay(400);
        return { path: String(params.out_path ?? "/mock/data/exports/speech.wav"), size_bytes: 1000, probe: {} };
      case "library.folders":
        return { folders: [] };
      case "library.tags":
        return { tags: [] };
      case "export.loudness_targets":
        return { targets: [{ id: "podcast-16", label: "Podcast (-16 LUFS, -1 dBTP)", integrated_lufs: -16, true_peak_dbtp: -1, lra: 11, description: "mock" }, { id: "streaming-14", label: "Streaming (-14 LUFS, -1 dBTP)", integrated_lufs: -14, true_peak_dbtp: -1, lra: 11, description: "mock" }] };
      case "record.scripts":
        return { scripts: [{ id: "rainbow", title: "The Rainbow Passage", style: "neutral", text: "When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. The rainbow is a division of white light into many beautiful colors. These take the shape of a long round arch, with its path high above, and its two ends apparently beyond the horizon.", approx_seconds: 25 }, { id: "news", title: "News read", style: "news", text: "Good evening. Here are tonight's top stories: local volunteers opened a new community garden, and forecasters expect clear skies for the weekend.", approx_seconds: 15 }] };
      default:
        fail("NOT_FOUND", `Method ${method} is not implemented by the preview mock`, { method }, false);
    }
    return undefined;
  }

  return {
    kind: "mock",
    async invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
      switch (cmd) {
        case "worker_request": {
          const id = String(args.id ?? "");
          return (await dispatch(id, String(args.method), (args.params as Record<string, unknown>) ?? {})) as T;
        }
        case "worker_cancel":
          state.cancelled.add(String(args.id ?? ""));
          return undefined as T;
        case "worker_status":
          return { ...state.status } as T;
        case "worker_restart":
          state.status = { ...state.status, restarts: state.status.restarts + 1 };
          emit("worker://status", { ...state.status, running: false });
          await delay(500);
          emit("worker://status", { ...state.status, running: true });
          return undefined as T;
        case "app_paths":
          return { data: "/mock/data", config: "/mock/config", cache: "/mock/cache", models: "/mock/data/models", logs: "/mock/data/logs" } as T;
        case "runtime_status":
          return {
            python: "/mock/data/runtime/main/bin/python",
            pythonpath: "/mock/backend",
            mode: "managed",
            found: true,
            python_found: true,
            package_found: true,
            source: "managed",
            runtime_root: "/mock/data/runtime",
            bootstrap_script: "/mock/scripts/bootstrap.sh",
            bootstrap_script_found: true,
            bootstrap_running: false,
            standalone: true,
          } satisfies RuntimeStatus as T;
        case "runtime_bootstrap": {
          const withCb = args.withChatterbox === true;
          emit("runtime://log", { stream: "system", line: `$ bash /mock/scripts/bootstrap.sh --runtime-dir /mock/data/runtime ${withCb ? "--with-chatterbox" : "--without-chatterbox"}` });
          for (const line of ["[mock] creating virtual environment…", "[mock] installing torch (skipped in preview)", "[mock] done — nothing was installed"]) {
            await delay(300);
            emit("runtime://log", { stream: "stdout", line });
          }
          emit("runtime://log", { stream: "system", line: "bootstrap exited with code 0" });
          return 0 as T;
        }
        case "pick_audio_files":
          return ["/home/you/Recordings/interview.wav"] as T;
        case "pick_save_path":
          return `/home/you/${String(args.defaultName ?? "speech")}.${String(args.ext ?? "wav")}` as T;
        case "pick_text_file":
        case "pick_archive_file":
        case "pick_directory":
          console.info(`[PREVIEW MOCK] ${cmd}: native dialogs are unavailable in the browser`);
          return null as T;
        case "read_text_file":
          return "" as T;
        case "open_path":
        case "reveal_path":
          console.info(`[PREVIEW MOCK] ${cmd}`, args.path);
          return undefined as T;
        default:
          fail("NOT_FOUND", `Shell command ${cmd} is not mocked`, { cmd }, false);
      }
    },
    async listen<T>(channel: string, cb: (payload: T) => void): Promise<() => void> {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      const l = cb as Listener;
      set.add(l);
      return () => {
        set?.delete(l);
      };
    },
    convertFileSrc: (path) => path,
  };
}
