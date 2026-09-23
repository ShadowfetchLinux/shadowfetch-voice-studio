/**
 * Typed client for the worker protocol and the Rust shell commands.
 *
 * This is the ONLY module that imports `invoke` / `listen` / `convertFileSrc` from @tauri-apps/api.
 * Outside Tauri (plain browser during `vite dev`) it routes to the explicit preview mock in ./devmock.ts,
 * which is guarded by `import.meta.env.DEV` and never used inside the desktop app.
 */
import { invoke as tauriInvoke, convertFileSrc as tauriConvertFileSrc } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

import type {
  AppPathsInfo,
  MethodName,
  ParamsOf,
  Progress,
  ResultOf,
  RuntimeBootstrapArgs,
  RuntimeLogLine,
  RuntimeStatus,
  ShellCommandName,
  ShellCommands,
  ShellEventName,
  ShellEvents,
  WorkerEventName,
  WorkerEvents,
  WorkerStatus,
} from "./protocol";
import { WorkerError } from "./protocol";

// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------

/** Minimal surface the client needs; implemented by Tauri and by the dev mock. */
export interface Transport {
  readonly kind: "tauri" | "mock";
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, cb: (payload: T) => void): Promise<() => void>;
  convertFileSrc(path: string): string;
}

/** True when running inside the Tauri webview. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const tauriTransport: Transport = {
  kind: "tauri",
  invoke: (cmd, args) => tauriInvoke(cmd, args),
  listen: async (event, cb) => tauriListen(event, (e) => cb(e.payload as never)),
  convertFileSrc: (path) => tauriConvertFileSrc(path),
};

let transportPromise: Promise<Transport> | null = null;
let activeTransport: Transport | null = null;

async function selectTransport(): Promise<Transport> {
  if (isTauri()) return tauriTransport;
  if (import.meta.env.DEV) {
    const mod = await import("./devmock");
    return mod.createMockTransport();
  }
  throw new WorkerError({
    code: "CLIENT",
    message: "Shadowfetch Voice Studio must run inside the desktop shell (no Tauri runtime detected).",
    recoverable: false,
  });
}

function getTransport(): Promise<Transport> {
  if (!transportPromise) {
    transportPromise = selectTransport().then((t) => {
      activeTransport = t;
      return t;
    });
  }
  return transportPromise;
}

/** Synchronous view of the selected transport kind ("mock" only in browser preview). */
export function transportKind(): "tauri" | "mock" | "pending" {
  if (activeTransport) return activeTransport.kind;
  return isTauri() ? "tauri" : "pending";
}

/** Whether the UI is being fed by the browser-preview mock (drives the "PREVIEW MOCK" header badge). */
export function isPreviewMock(): boolean {
  return !isTauri() && import.meta.env.DEV;
}

/** Test hook: forget the selected transport and listeners so a fresh environment can be set up. */
export function __resetForTests(): void {
  transportPromise = null;
  activeTransport = null;
  progressListener = null;
  eventListener = null;
  statusListener = null;
  runtimeLogListener = null;
  progressHandlers.clear();
  eventHandlers.clear();
  statusHandlers.clear();
  runtimeLogHandlers.clear();
  for (const c of mediaUrlCache.values()) {
    if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(c.url);
  }
  mediaUrlCache.clear();
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // RFC 4122 v4 fallback (older WebKitGTK builds without randomUUID)
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Progress routing (one Tauri listener, fan-out by request id)
// ---------------------------------------------------------------------------

type ProgressHandler = (p: Progress) => void;
const progressHandlers = new Map<string, ProgressHandler>();
let progressListener: Promise<() => void> | null = null;

async function ensureProgressListener(): Promise<void> {
  if (!progressListener) {
    const t = await getTransport();
    progressListener = t.listen<Progress>("worker://progress", (p) => {
      const h = p && progressHandlers.get(p.id);
      if (h) {
        try {
          h(p);
        } catch (err) {
          console.error("progress handler failed", err);
        }
      }
    });
  }
  await progressListener;
}

// ---------------------------------------------------------------------------
// request / cancel
// ---------------------------------------------------------------------------

export interface RequestOptions {
  onProgress?: ProgressHandler;
  signal?: AbortSignal;
  /** Override the generated request id (tests / retries). */
  id?: string;
}

/** A promise that also exposes the request id and a cancel shortcut. */
export type RequestPromise<T> = Promise<T> & { readonly id: string; cancel: () => Promise<void> };

/** Ask the worker to cancel an in-flight request (best effort; the request ends with CANCELLED). */
export async function cancel(id: string): Promise<void> {
  const t = await getTransport();
  try {
    await t.invoke<void>("worker_cancel", { id });
  } catch (err) {
    console.warn("worker_cancel failed", err);
  }
}

/**
 * Send one protocol request through the shell (`worker_request`) and resolve with its result.
 * Progress messages carrying the same id are delivered to `onProgress`. Errors are always `WorkerError`.
 */
export function request<M extends MethodName>(method: M, params: ParamsOf<M>, opts: RequestOptions = {}): RequestPromise<ResultOf<M>> {
  return requestRaw<ResultOf<M>>(method, params, opts);
}

/** Untyped variant for methods not (yet) in the `Methods` table. */
export function requestRaw<T>(method: string, params: unknown, opts: RequestOptions = {}): RequestPromise<T> {
  const id = opts.id ?? newRequestId();
  const { onProgress, signal } = opts;

  const run = async (): Promise<T> => {
    if (signal?.aborted) throw new WorkerError({ code: "CANCELLED", message: "Cancelled before start", details: {}, recoverable: true }, method);
    const t = await getTransport();
    if (onProgress) {
      await ensureProgressListener();
      progressHandlers.set(id, onProgress);
    }
    const onAbort = () => {
      void cancel(id);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await t.invoke<T>("worker_request", { id, method, params: params ?? {} });
    } catch (err) {
      throw WorkerError.from(err, method);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      progressHandlers.delete(id);
    }
  };

  const p = run() as RequestPromise<T>;
  Object.defineProperty(p, "id", { value: id, enumerable: true });
  Object.defineProperty(p, "cancel", { value: () => cancel(id), enumerable: true });
  return p;
}

// ---------------------------------------------------------------------------
// Shell commands (non-worker)
// ---------------------------------------------------------------------------

async function shell<C extends ShellCommandName>(cmd: C, args?: ShellCommands[C]["args"]): Promise<ShellCommands[C]["result"]> {
  const t = await getTransport();
  try {
    return await t.invoke<ShellCommands[C]["result"]>(cmd, (args ?? {}) as Record<string, unknown>);
  } catch (err) {
    throw WorkerError.from(err, cmd);
  }
}

// ---------------------------------------------------------------------------
// Unsolicited events, worker status and runtime log subscriptions
// ---------------------------------------------------------------------------

type Handler<T> = (data: T) => void;
const mediaUrlCache = new Map<string, { url: string; refs: number; bytes: number }>();
const eventHandlers = new Map<string, Set<Handler<unknown>>>();
const statusHandlers = new Set<Handler<WorkerStatus>>();
const runtimeLogHandlers = new Set<Handler<RuntimeLogLine>>();
let eventListener: Promise<() => void> | null = null;
let statusListener: Promise<() => void> | null = null;
let runtimeLogListener: Promise<() => void> | null = null;

function ensureShellListener<E extends ShellEventName>(
  slot: "event" | "status" | "log",
  channel: E,
  dispatch: (payload: ShellEvents[E]) => void,
): void {
  const current = slot === "event" ? eventListener : slot === "status" ? statusListener : runtimeLogListener;
  if (current) return;
  const p = getTransport()
    .then((t) => t.listen<ShellEvents[E]>(channel, dispatch))
    .catch((err) => {
      console.error(`listen(${channel}) failed`, err);
      return () => {};
    });
  if (slot === "event") eventListener = p;
  else if (slot === "status") statusListener = p;
  else runtimeLogListener = p;
}

function subscribe<T>(set: Set<Handler<T>>, cb: Handler<T>): () => void {
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}

export const events = {
  /** Subscribe to a worker event (`record.level`, `engine.state`, ...). Returns an unsubscribe function. */
  on<E extends WorkerEventName>(name: E, cb: (data: WorkerEvents[E]) => void): () => void {
    ensureShellListener("event", "worker://event", (payload) => {
      const set = eventHandlers.get(payload.event);
      if (!set) return;
      for (const h of set) {
        try {
          h(payload.data);
        } catch (err) {
          console.error(`event handler for ${payload.event} failed`, err);
        }
      }
    });
    let set = eventHandlers.get(name);
    if (!set) {
      set = new Set();
      eventHandlers.set(name, set);
    }
    return subscribe(set, cb as Handler<unknown>);
  },

  /** Worker supervisor status changes (`worker://status`). */
  onWorkerStatus(cb: Handler<WorkerStatus>): () => void {
    ensureShellListener("status", "worker://status", (s) => {
      for (const h of statusHandlers) h(s);
    });
    return subscribe(statusHandlers, cb);
  },

  /**
   * Files dropped onto the app window (Tauri `tauri://drag-drop`; payload `{paths, position}`).
   * Paths are OS-provided absolute paths of files the user chose to drop; the worker re-validates them.
   * Returns an unsubscribe function. Does nothing in the browser preview.
   */
  onFileDrop(cb: (paths: string[]) => void): () => void {
    let active = true;
    let stop: (() => void) | null = null;
    getTransport()
      .then((t) => {
        if (t.kind !== "tauri") return;
        return t.listen<{ paths?: string[] }>("tauri://drag-drop", (payload) => {
          const paths = Array.isArray(payload?.paths) ? payload.paths.filter((x): x is string => typeof x === "string") : [];
          if (active && paths.length) cb(paths);
        });
      })
      .then((unlisten) => {
        if (!unlisten) return;
        if (active) stop = unlisten;
        else unlisten();
      })
      .catch((err) => console.error("drag-drop listener failed", err));
    return () => {
      active = false;
      stop?.();
    };
  },

  /** Lines streamed by `runtime_bootstrap` (`runtime://log`). */
  onRuntimeLog(cb: Handler<RuntimeLogLine>): () => void {
    ensureShellListener("log", "runtime://log", (l) => {
      for (const h of runtimeLogHandlers) h(l);
    });
    return subscribe(runtimeLogHandlers, cb);
  },
};

// ---------------------------------------------------------------------------
// Typed helpers grouped by namespace
// ---------------------------------------------------------------------------

type Opts = RequestOptions | undefined;
const none = {} as Record<string, never>;

export const api = {
  request,
  requestRaw,
  cancel,
  events,

  system: {
    ping: (o?: Opts) => request("system.ping", none, o),
    diagnostics: (o?: Opts) => request("system.diagnostics", none, o),
    cudaSmokeTest: (p: ParamsOf<"system.cuda_smoke_test"> = {}, o?: Opts) => request("system.cuda_smoke_test", p, o),
    gpuStatus: (o?: Opts) => request("system.gpu_status", none, o),
    setOffline: (offline: boolean, o?: Opts) => request("system.set_offline", { offline }, o),
    settingsGet: (o?: Opts) => request("system.settings.get", none, o),
    settingsSet: (patch: ParamsOf<"system.settings.set">["patch"], o?: Opts) => request("system.settings.set", { patch }, o),
    storageUsage: (o?: Opts) => request("system.storage_usage", none, o),
    clearCache: (kinds: ParamsOf<"system.clear_cache">["kinds"], o?: Opts) => request("system.clear_cache", { kinds }, o),
    logBundle: (o?: Opts) => request("system.log_bundle", none, o),
  },

  audio: {
    probe: (path: string, o?: Opts) => request("audio.probe", { path }, o),
    import: (p: ParamsOf<"audio.import">, o?: Opts) => request("audio.import", p, o),
    peaks: (p: ParamsOf<"audio.peaks">, o?: Opts) => request("audio.peaks", p, o),
    stats: (p: ParamsOf<"audio.stats">, o?: Opts) => request("audio.stats", p, o),
    trim: (p: ParamsOf<"audio.trim">, o?: Opts) => request("audio.trim", p, o),
    prepareReference: (p: ParamsOf<"audio.prepare_reference">, o?: Opts) => request("audio.prepare_reference", p, o),
    previewProcessing: (p: ParamsOf<"audio.preview_processing">, o?: Opts) => request("audio.preview_processing", p, o),
    playDeviceTest: (p: ParamsOf<"audio.play_device_test"> = {}, o?: Opts) => request("audio.play_device_test", p, o),
    suggestReference: (p: ParamsOf<"audio.suggest_reference">, o?: Opts) => request("audio.suggest_reference", p, o),
  },

  record: {
    devices: (o?: Opts) => request("record.devices", none, o),
    start: (p: ParamsOf<"record.start"> = {}, o?: Opts) => request("record.start", p, o),
    pause: (session_id: string, o?: Opts) => request("record.pause", { session_id }, o),
    resume: (session_id: string, o?: Opts) => request("record.resume", { session_id }, o),
    stop: (session_id: string, o?: Opts) => request("record.stop", { session_id }, o),
    discard: (session_id: string, o?: Opts) => request("record.discard", { session_id }, o),
    scripts: (o?: Opts) => request("record.scripts", none, o),
  },

  transcribe: {
    models: (o?: Opts) => request("transcribe.models", none, o),
    run: (p: ParamsOf<"transcribe.run">, o?: Opts) => request("transcribe.run", p, o),
    unload: (o?: Opts) => request("transcribe.unload", none, o),
  },

  engine: {
    list: (o?: Opts) => request("engine.list", none, o),
    capabilities: (engine_id: string, o?: Opts) => request("engine.capabilities", { engine_id }, o),
    load: (p: ParamsOf<"engine.load">, o?: Opts) => request("engine.load", p, o),
    unload: (engine_id: string, o?: Opts) => request("engine.unload", { engine_id }, o),
    health: (engine_id: string, o?: Opts) => request("engine.health", { engine_id }, o),
    prepareReference: (p: ParamsOf<"engine.prepare_reference">, o?: Opts) => request("engine.prepare_reference", p, o),
    generate: (p: ParamsOf<"engine.generate">, o?: Opts) => request("engine.generate", p, o),
  },

  tts: {
    plan: (p: ParamsOf<"tts.plan">, o?: Opts) => request("tts.plan", p, o),
    generate: (p: ParamsOf<"tts.generate">, o?: Opts) => request("tts.generate", p, o),
    assemble: (p: ParamsOf<"tts.assemble">, o?: Opts) => request("tts.assemble", p, o),
    compareEngines: (p: ParamsOf<"tts.compare_engines">, o?: Opts) => request("tts.compare_engines", p, o),
  },

  voices: {
    create: (p: ParamsOf<"voices.create">, o?: Opts) => request("voices.create", p, o),
    list: (o?: Opts) => request("voices.list", none, o),
    get: (id: string, o?: Opts) => request("voices.get", { id }, o),
    update: (p: ParamsOf<"voices.update">, o?: Opts) => request("voices.update", p, o),
    delete: (p: ParamsOf<"voices.delete">, o?: Opts) => request("voices.delete", p, o),
    addReference: (p: ParamsOf<"voices.add_reference">, o?: Opts) => request("voices.add_reference", p, o),
    selectReference: (p: ParamsOf<"voices.select_reference">, o?: Opts) => request("voices.select_reference", p, o),
    updateReference: (p: ParamsOf<"voices.update_reference">, o?: Opts) => request("voices.update_reference", p, o),
  },

  dataset: {
    export: (p: ParamsOf<"dataset.export">, o?: Opts) => request("dataset.export", p, o),
    preflight: (p: ParamsOf<"dataset.preflight"> = {}, o?: Opts) => request("dataset.preflight", p, o),
  },

  projects: {
    create: (p: ParamsOf<"projects.create">, o?: Opts) => request("projects.create", p, o),
    list: (p: ParamsOf<"projects.list"> = {}, o?: Opts) => request("projects.list", p, o),
    get: (id: string, o?: Opts) => request("projects.get", { id }, o),
    update: (p: ParamsOf<"projects.update">, o?: Opts) => request("projects.update", p, o),
    duplicate: (id: string, o?: Opts) => request("projects.duplicate", { id }, o),
    archive: (p: ParamsOf<"projects.archive">, o?: Opts) => request("projects.archive", p, o),
    delete: (id: string, o?: Opts) => request("projects.delete", { id, confirm: true }, o),
    saveScript: (p: ParamsOf<"projects.save_script">, o?: Opts) => request("projects.save_script", p, o),
    selectTake: (p: ParamsOf<"projects.select_take">, o?: Opts) => request("projects.select_take", p, o),
  },

  speak: {
    session: (p: ParamsOf<"speak.session"> = {}, o?: Opts) => request("speak.session", p, o),
    history: (p: ParamsOf<"speak.history"> = {}, o?: Opts) => request("speak.history", p, o),
    remember: (p: ParamsOf<"speak.remember">, o?: Opts) => request("speak.remember", p, o),
    forget: (id: string, o?: Opts) => request("speak.forget", { id }, o),
  },

  library: {
    search: (p: ParamsOf<"library.search">, o?: Opts) => request("library.search", p, o),
    folders: (o?: Opts) => request("library.folders", none, o),
    tags: (o?: Opts) => request("library.tags", none, o),
  },

  backup: {
    export: (p: ParamsOf<"backup.export">, o?: Opts) => request("backup.export", p, o),
    import: (path: string, o?: Opts) => request("backup.import", { path }, o),
  },

  export: {
    render: (p: ParamsOf<"export.render">, o?: Opts) => request("export.render", p, o),
    loudnessTargets: (o?: Opts) => request("export.loudness_targets", none, o),
  },

  models: {
    list: (o?: Opts) => request("models.list", none, o),
    state: (model_id: string, o?: Opts) => request("models.state", { model_id }, o),
    download: (model_id: string, o?: Opts) => request("models.download", { model_id }, o),
    cancelDownload: (model_id: string, o?: Opts) => request("models.cancel_download", { model_id }, o),
    verify: (model_id: string, o?: Opts) => request("models.verify", { model_id }, o),
    useExistingDir: (p: ParamsOf<"models.use_existing_dir">, o?: Opts) => request("models.use_existing_dir", p, o),
    remove: (model_id: string, o?: Opts) => request("models.remove", { model_id, confirm: true }, o),
  },

  /** Rust shell commands: supervisor, dialogs, files. */
  shell: {
    workerStatus: (): Promise<WorkerStatus> => shell("worker_status"),
    workerRestart: (): Promise<void> => shell("worker_restart"),
    appPaths: (): Promise<AppPathsInfo> => shell("app_paths"),
    runtimeStatus: (): Promise<RuntimeStatus> => shell("runtime_status"),
    /**
     * Run scripts/bootstrap.sh through the shell. Resolves with the exit code (0); the Rust command rejects
     * with a `WorkerError` on a non-zero exit, when a bootstrap is already running (`BUSY`) or when the script is missing.
     */
    runtimeBootstrap: (opts: RuntimeBootstrapArgs = {}): Promise<number> => shell("runtime_bootstrap", opts),
    pickAudioFiles: (): Promise<string[]> => shell("pick_audio_files").then((r) => r ?? []),
    pickTextFile: (): Promise<string | null> => shell("pick_text_file"),
    pickSavePath: (defaultName: string, ext: string): Promise<string | null> => shell("pick_save_path", { defaultName, ext }),
    pickArchiveFile: (): Promise<string | null> => shell("pick_archive_file"),
    pickDirectory: (): Promise<string | null> => shell("pick_directory"),
    readTextFile: (path: string): Promise<string> => shell("read_text_file", { path }),
    openPath: (path: string): Promise<void> => shell("open_path", { path }),
    revealPath: (path: string): Promise<void> => shell("reveal_path", { path }),
    /** URL an <audio>/<img> element can load for a local file (Tauri asset protocol). */
    fileSrc: (path: string): string => {
      if (activeTransport) return activeTransport.convertFileSrc(path);
      return isTauri() ? tauriTransport.convertFileSrc(path) : path;
    },
    /**
     * Playable URL for a local audio file. WebKitGTK's media player refuses custom URI schemes
     * (only blob/data/file/http(s)), so inside Tauri the bytes are fetched through the scoped
     * asset protocol and exposed as a `blob:` object URL. Cached per path+mtime hint; call
     * `releaseMediaSrc` when a player is done with it.
     */
    mediaSrc: async (path: string): Promise<string> => {
      if (!isTauri()) return path;
      const cached = mediaUrlCache.get(path);
      if (cached) {
        cached.refs += 1;
        return cached.url;
      }
      const res = await fetch(tauriTransport.convertFileSrc(path));
      if (!res.ok) throw new WorkerError({ code: "NOT_FOUND", message: `Could not read ${path} (${res.status})`, recoverable: true });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      mediaUrlCache.set(path, { url, refs: 1, bytes: blob.size });
      return url;
    },
    releaseMediaSrc: (path: string): void => {
      const c = mediaUrlCache.get(path);
      if (!c) return;
      c.refs -= 1;
      if (c.refs <= 0) {
        URL.revokeObjectURL(c.url);
        mediaUrlCache.delete(path);
      }
    },
  },
} as const;

export type Api = typeof api;
export { WorkerError };
