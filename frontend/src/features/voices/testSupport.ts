/**
 * Test-only helpers: an in-memory worker event bus and a fully mocked `@/lib/api` module surface.
 * Used by src/__tests__/voices*.test.tsx and library*.test.tsx through `vi.mock("@/lib/api", …)`.
 */
import { vi } from "vitest";
import { WorkerError } from "@/lib/protocol";

export interface EventBus {
  emit: (name: string, data: unknown) => void;
  on: (name: string, cb: (data: unknown) => void) => () => void;
  clear: () => void;
}

export function createEventBus(): EventBus {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  return {
    emit: (name, data) => {
      for (const h of handlers.get(name) ?? []) h(data);
    },
    on: (name, cb) => {
      let set = handlers.get(name);
      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }
      set.add(cb);
      return () => {
        set?.delete(cb);
      };
    },
    clear: () => handlers.clear(),
  };
}

/** Plain-object error the Rust command would reject with (so `WorkerError.from` normalises it). */
export function workerFailure(code: string, message: string, details: Record<string, unknown> = {}, recoverable = true) {
  return { code, message, details, recoverable };
}

type AnyFn = (...args: never[]) => unknown;
const fn = <T extends AnyFn>(impl?: T) => vi.fn(impl as AnyFn) as unknown as ReturnType<typeof vi.fn>;
const resolve = (value: unknown) => fn(() => Promise.resolve(value));

/** Build the mocked module. Every method is a `vi.fn` resolving to a sensible empty value; override per test. */
export function makeApiModule(bus: EventBus) {
  const api = {
    request: fn(() => Promise.reject(new Error("request() not mocked"))),
    requestRaw: resolve({ projects: [] }),
    cancel: resolve(undefined),
    events: {
      on: fn((name: string, cb: (d: unknown) => void) => bus.on(name, cb)),
      onWorkerStatus: fn(() => () => {}),
      onRuntimeLog: fn(() => () => {}),
      onFileDrop: fn(() => () => {}),
    },
    system: { settingsGet: resolve({}), diagnostics: resolve({}), gpuStatus: resolve({ gpus: [] }) },
    audio: {
      import: resolve({}),
      peaks: resolve({ points: 0, duration_s: 0, sample_rate: 48000, peaks: [] }),
      stats: resolve({ duration_s: 0, sample_rate: 48000, channels: 1, peak_dbfs: -6, rms_dbfs: -20, clipping_samples: 0, leading_silence_s: 0, trailing_silence_s: 0, silence_ratio: 0, warnings: [] }),
      trim: resolve({ path: "/cache/tmp/cut.wav", duration_s: 1 }),
      prepareReference: resolve({}),
      previewProcessing: resolve({ path: "/cache/tmp/preview.wav" }),
      probe: resolve({}),
      playDeviceTest: resolve({ ok: true }),
    },
    record: {
      devices: resolve({ inputs: [], default_input: null, backend: "sounddevice", notes: [] }),
      start: resolve({}),
      pause: resolve({}),
      resume: resolve({}),
      stop: resolve({}),
      discard: resolve({ ok: true }),
      scripts: resolve({ scripts: [] }),
    },
    transcribe: { models: resolve({ models: [] }), run: resolve({}), unload: resolve({ ok: true }) },
    engine: { list: resolve({ engines: [] }), capabilities: resolve({}), load: resolve({}), unload: resolve({ ok: true }), health: resolve({ alive: false }), prepareReference: resolve({}), generate: resolve({}) },
    dataset: { export: resolve({ path: "/tmp/ds", jsonl: "/tmp/ds/train_raw.jsonl", samples: 0, skipped: [], reference: "/tmp/ds/ref.wav", total_seconds: 0 }), preflight: resolve({ gpu: "none", vram_total_gb: 0, vram_free_gb: 0, estimate_gb: { total: 28 }, host_ram_peak_gb: 7, host_ram_free_gb: null, fits: false, verdict: "does not fit" }) },
    tts: { plan: resolve({}), generate: resolve({}), assemble: resolve({}), compareEngines: resolve({}) },
    voices: { create: resolve({}), list: resolve({ voices: [] }), get: resolve({}), update: resolve({}), delete: resolve({ ok: true }), addReference: resolve({}), selectReference: resolve({ ok: true }), updateReference: resolve({}) },
    projects: { create: resolve({}), list: resolve({ projects: [] }), get: resolve({}), update: resolve({}), duplicate: resolve({}), archive: resolve({ ok: true }), delete: resolve({ ok: true }), saveScript: resolve({}), selectTake: resolve({ ok: true }) },
    library: { search: resolve({ projects: [], voices: [] }), folders: resolve({ folders: [] }), tags: resolve({ tags: [] }) },
    backup: { export: resolve({ path: "/x.zip", size_bytes: 1 }), import: resolve({ project_id: "p" }) },
    export: { render: resolve({}), loudnessTargets: resolve({ targets: [] }) },
    models: { list: resolve({ models: [] }), state: resolve({}), download: resolve({}), cancelDownload: resolve({ ok: true }), verify: resolve({}), useExistingDir: resolve({}), remove: resolve({ ok: true }) },
    shell: {
      workerStatus: resolve({ running: true, restarts: 0, last_error: null, stopped: false }),
      workerRestart: resolve(undefined),
      appPaths: resolve({ data: "/data", config: "/config", cache: "/cache" }),
      runtimeStatus: resolve({
        python: "/data/runtime/envs/main/bin/python",
        pythonpath: "/backend",
        mode: "managed",
        found: true,
        python_found: true,
        package_found: true,
        source: "managed",
        runtime_root: "/data/runtime",
        bootstrap_script: "/scripts/bootstrap.sh",
        bootstrap_script_found: true,
        bootstrap_running: false,
        standalone: true,
      }),
      runtimeBootstrap: resolve({}),
      pickAudioFiles: resolve([]),
      pickTextFile: resolve(null),
      pickSavePath: resolve(null),
      pickArchiveFile: resolve(null),
      pickDirectory: resolve(null),
      readTextFile: resolve(""),
      openPath: resolve(undefined),
      revealPath: resolve(undefined),
      fileSrc: fn((p: string) => `asset://${p}`),
      mediaSrc: fn(async (p: string) => `asset://${p}`),
      releaseMediaSrc: fn(() => undefined),
    },
  };
  return {
    api,
    WorkerError,
    isTauri: () => false,
    isPreviewMock: () => false,
    transportKind: () => "mock" as const,
    newRequestId: () => "00000000-0000-4000-8000-000000000000",
    request: api.request,
    requestRaw: api.requestRaw,
    cancel: api.cancel,
    events: api.events,
    __resetForTests: () => {},
  };
}

export type ApiMock = ReturnType<typeof makeApiModule>["api"];
