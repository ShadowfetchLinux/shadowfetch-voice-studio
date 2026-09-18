import { useMemo } from "react";
import { create } from "zustand";
import { api, isPreviewMock } from "@/lib/api";
import type {
  Diagnostics,
  EngineInfo,
  EngineStateEvent,
  GpuStatus,
  ModelInfo,
  ModelStateEvent,
  Settings,
  SettingsPatch,
  WorkerStatus,
} from "@/lib/protocol";
import { WorkerError } from "@/lib/protocol";
import { toast, useToastStore } from "@/components/ui/Toast";

export type Page = "home" | "voices" | "create" | "library" | "settings" | "setup";

/** Optional parameters for a page (e.g. open a project, start the recorder). */
export interface RouteParams {
  projectId?: string;
  voiceId?: string;
  /** Initial action for the target page: voices→"record"/"import", create→"new". */
  action?: "record" | "import" | "new";
  /** Settings section to scroll to. */
  section?: string;
}

export interface AppState {
  // routing
  page: Page;
  params: RouteParams;
  navigate: (page: Page, params?: RouteParams) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;

  // environment
  mock: boolean;
  booted: boolean;
  bootError: string | null;

  // live data
  workerStatus: WorkerStatus | null;
  diagnostics: Diagnostics | null;
  diagnosticsLoading: boolean;
  settings: Settings | null;
  engines: EngineInfo[];
  models: ModelInfo[];
  gpu: GpuStatus | null;
  gpuUpdatedAt: number | null;
  /** Latest `engine.state` per engine (overrides `engines[].state` between reloads). */
  engineStates: Record<string, EngineStateEvent>;
  /** Latest `model.state` per model (download progress in bytes). */
  modelStates: Record<string, ModelStateEvent>;

  // loaders
  boot: () => Promise<void>;
  loadDiagnostics: () => Promise<Diagnostics | null>;
  loadSettings: () => Promise<Settings | null>;
  saveSettings: (patch: SettingsPatch, opts?: { silent?: boolean }) => Promise<Settings | null>;
  loadEngines: () => Promise<EngineInfo[]>;
  loadModels: () => Promise<ModelInfo[]>;
  refreshGpu: () => Promise<void>;
  setWorkerStatus: (s: WorkerStatus) => void;
  applyEngineState: (e: EngineStateEvent) => void;
  applyModelState: (e: ModelStateEvent) => void;
}

/**
 * Report a failed call: shows an error toast (except for user cancellations) and returns the
 * normalised `WorkerError` so callers can branch on `code`.
 */
export function handleError(err: unknown, title = "Something went wrong"): WorkerError {
  const we = WorkerError.from(err);
  if (we.cancelled) return we;
  const detail = we.code && we.code !== "CLIENT" ? `${we.message}\n(${we.code}${we.recoverable ? "" : ", restart may be required"})` : we.message;
  toast.error(title, detail);
  return we;
}

type Set = (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void;
type Get = () => AppState;

let bootInFlight: Promise<void> | null = null;

/**
 * Load everything the UI needs from the worker. No worker request is sent until the supervisor reports
 * `running` — while the worker is still starting the shell shows "Starting local worker…" and the
 * `worker://status` subscription (App.tsx) calls `boot()` again once it is up (also after a restart).
 */
async function runBoot(set: Set, get: Get): Promise<void> {
  try {
    const snapshot = await api.shell.workerStatus().catch(() => null);
    // A `worker://status` event that arrived while the snapshot was in flight is newer than the snapshot
    // (the subscription is registered before the first boot), so it wins; otherwise adopt the snapshot.
    const status = get().workerStatus ?? snapshot;
    if (snapshot && !get().workerStatus) set({ workerStatus: snapshot });
    if (status && !status.running) {
      // Gave up (crash loop, no interpreter): say so and offer a restart. Otherwise wait for the status event.
      if (status.stopped) set({ booted: true, bootError: status.last_error ?? "The local worker is not running." });
      else set({ booted: false, bootError: null });
      return;
    }
    const firstBoot = get().settings == null;
    const settings = await get().loadSettings();
    // First run → guided setup (only on the initial boot, never when the worker comes back after a restart).
    if (firstBoot && settings && !settings.onboarding_done) set({ page: "setup", params: {} });
    set({ booted: true, bootError: null });
    // Everything else loads in the background; the new worker process has fresh engine/model state.
    void Promise.all([get().loadDiagnostics(), get().loadEngines(), get().loadModels(), get().refreshGpu()]);
  } catch (err) {
    const we = WorkerError.from(err);
    set({ booted: true, bootError: we.message });
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  page: "home",
  params: {},
  navigate: (page, params = {}) => set({ page, params, shortcutsOpen: false }),
  shortcutsOpen: false,
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),

  mock: isPreviewMock(),
  booted: false,
  bootError: null,

  workerStatus: null,
  diagnostics: null,
  diagnosticsLoading: false,
  settings: null,
  engines: [],
  models: [],
  gpu: null,
  gpuUpdatedAt: null,
  engineStates: {},
  modelStates: {},

  boot() {
    // One boot at a time: the status subscription and the initial call can both ask for it.
    if (!bootInFlight) {
      bootInFlight = runBoot(set, get).finally(() => {
        bootInFlight = null;
      });
    }
    return bootInFlight;
  },

  async loadDiagnostics() {
    set({ diagnosticsLoading: true });
    try {
      const d = await api.system.diagnostics();
      set({ diagnostics: d, diagnosticsLoading: false });
      return d;
    } catch (err) {
      set({ diagnosticsLoading: false });
      handleError(err, "Could not read system diagnostics");
      return null;
    }
  },

  async loadSettings() {
    try {
      const s = await api.system.settingsGet();
      set({ settings: s });
      return s;
    } catch (err) {
      handleError(err, "Could not load settings");
      return null;
    }
  },

  async saveSettings(patch, opts) {
    const prev = get().settings;
    if (prev) set({ settings: { ...prev, ...patch } }); // optimistic
    try {
      const s = await api.system.settingsSet(patch);
      set({ settings: s });
      if (!opts?.silent) toast.success("Settings saved");
      return s;
    } catch (err) {
      if (prev) set({ settings: prev });
      handleError(err, "Could not save settings");
      return null;
    }
  },

  async loadEngines() {
    try {
      const r = await api.engine.list();
      set({ engines: r.engines });
      return r.engines;
    } catch (err) {
      handleError(err, "Could not list engines");
      return [];
    }
  },

  async loadModels() {
    try {
      const r = await api.models.list();
      set({ models: r.models });
      return r.models;
    } catch (err) {
      handleError(err, "Could not list models");
      return [];
    }
  },

  async refreshGpu() {
    try {
      const g = await api.system.gpuStatus();
      set({ gpu: g, gpuUpdatedAt: Date.now() });
      if (g.engines) {
        const merged = { ...get().engineStates };
        for (const [id, st] of Object.entries(g.engines)) merged[id] = { ...merged[id], ...st, engine_id: id };
        set({ engineStates: merged });
      }
    } catch {
      // polled; stay quiet, the worker pill already reports outages
    }
  },

  setWorkerStatus: (s) => set({ workerStatus: s }),

  applyEngineState: (e) =>
    set((s) => ({
      engineStates: { ...s.engineStates, [e.engine_id]: e },
      engines: s.engines.map((en) => (en.id === e.engine_id ? { ...en, state: e.state, model_id: e.model_id ?? null, vram_bytes: e.vram_bytes ?? null, message: e.message ?? "" } : en)),
    })),

  applyModelState: (e) =>
    set((s) => {
      const engineId = s.models.find((m) => m.id === e.model_id)?.engine_id ?? null;
      return {
        modelStates: { ...s.modelStates, [e.model_id]: e },
        models: s.models.map((m) => (m.id === e.model_id ? { ...m, state: e.state, error: e.state === "error" ? (e.message ?? m.error) : null } : m)),
        engines: engineId ? s.engines.map((en) => (en.id === engineId ? { ...en, model_state: e.state } : en)) : s.engines,
      };
    }),
}));

export interface LoadedEngine {
  engine: EngineInfo;
  state: EngineStateEvent;
}

/** Pure selector: the engine that is loaded (or loading) right now, merging live events over the last list. */
export function selectLoadedEngine(engines: EngineInfo[], engineStates: Record<string, EngineStateEvent>): LoadedEngine | null {
  for (const en of engines) {
    const live = engineStates[en.id];
    const state = live?.state ?? en.state;
    if (state === "loaded" || state === "loading") {
      return { engine: en, state: { engine_id: en.id, state, model_id: live?.model_id ?? en.model_id, vram_bytes: live?.vram_bytes ?? en.vram_bytes, message: live?.message ?? en.message } };
    }
  }
  return null;
}

/** Hook form of `selectLoadedEngine` (memoised — zustand selectors must not return fresh objects). */
export function useLoadedEngine(): LoadedEngine | null {
  const engines = useAppStore((s) => s.engines);
  const engineStates = useAppStore((s) => s.engineStates);
  return useMemo(() => selectLoadedEngine(engines, engineStates), [engines, engineStates]);
}

export { toast, useToastStore };
