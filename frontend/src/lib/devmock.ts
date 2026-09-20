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
  RuntimeStatus,
  Settings,
  StorageUsage,
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

interface MockState {
  settings: Settings;
  engines: EngineInfo[];
  models: ModelInfo[];
  projects: Project[];
  status: WorkerStatus;
  downloads: Map<string, { cancelled: boolean }>;
}

function initialState(): MockState {
  const now = new Date().toISOString();
  return {
    settings: { ...defaultSettings },
    status: { running: true, restarts: 0, last_error: null, stopped: false },
    downloads: new Map(),
    engines: [
      { id: "qwen3-tts-base", name: `Qwen3-TTS 1.7B Base ${MOCK}`, installed: true, state: "unloaded", model_state: "missing", optional: false, capabilities: qwenCaps },
      { id: "chatterbox-turbo", name: `Chatterbox-Turbo ${MOCK}`, installed: false, state: "unloaded", model_state: "missing", optional: true },
    ],
    models: [
      { id: "qwen3-tts-12hz-1.7b-base", engine_id: "qwen3-tts-base", kind: "tts", repo: "Qwen/Qwen3-TTS-12Hz-1.7B-Base", revision_pinned: null, size_bytes: null, approx_size_bytes: 4_000_000_000, license: "Apache-2.0", license_url: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base", state: "missing", description: `Primary engine ${MOCK}` },
      { id: "chatterbox-turbo", engine_id: "chatterbox-turbo", kind: "tts", repo: "ResembleAI/chatterbox-turbo", revision_pinned: null, size_bytes: null, approx_size_bytes: 1_200_000_000, license: "MIT (code) / see model card (weights)", license_url: "https://huggingface.co/ResembleAI/chatterbox-turbo", state: "missing", description: `Optional secondary engine ${MOCK}` },
      { id: "faster-whisper-small.en", kind: "asr", repo: "Systran/faster-whisper-small.en", revision_pinned: null, size_bytes: null, approx_size_bytes: 490_000_000, license: "MIT", state: "missing", description: `English transcription ${MOCK}` },
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
      case "record.scripts":
        return { scripts: [] };
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
      case "voices.list":
        return { voices: [] };
      case "library.folders":
        return { folders: [] };
      case "library.tags":
        return { tags: [] };
      case "export.loudness_targets":
        return { targets: [] };
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
          return [] as T;
        case "pick_text_file":
        case "pick_save_path":
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
