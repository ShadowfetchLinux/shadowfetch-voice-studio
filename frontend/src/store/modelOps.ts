import { create } from "zustand";
import { api, type RequestPromise } from "@/lib/api";
import type { ModelVerifyResult } from "@/lib/protocol";
import { WorkerError } from "@/lib/protocol";
import { handleError, toast, useAppStore } from "./appStore";

export interface DownloadJob {
  model_id: string;
  request_id: string;
  stage: string;
  message: string;
  bytes_done: number | null;
  bytes_total: number | null;
  /** Non-byte counts when the worker reports files instead (current/total). */
  current: number | null;
  total: number | null;
}

interface ModelOpsState {
  downloads: Record<string, DownloadJob>;
  busy: Record<string, "verify" | "remove" | "use_existing" | "load" | "unload" | undefined>;
  /** Last download failure per model (cleared when a new download starts); CANCELLED is not recorded. */
  errors: Record<string, WorkerError | undefined>;
  /** `quiet`: no toasts — the caller (the setup dialog) shows progress and errors itself. */
  startDownload: (model_id: string, opts?: { quiet?: boolean }) => Promise<boolean>;
  cancelDownload: (model_id: string) => Promise<void>;
  verify: (model_id: string) => Promise<ModelVerifyResult | null>;
  useExistingDir: (model_id: string) => Promise<boolean>;
  remove: (model_id: string) => Promise<boolean>;
  loadEngine: (engine_id: string) => Promise<boolean>;
  unloadEngine: (engine_id: string) => Promise<boolean>;
}

const handles = new Map<string, RequestPromise<unknown>>();
/** The running `startDownload` per model, so a second caller (the setup dialog, a Settings row) waits for the same one. */
const inflight = new Map<string, Promise<boolean>>();

/** Long-running model/engine operations that must survive page navigation. */
export const useModelOps = create<ModelOpsState>((set) => ({
  downloads: {},
  busy: {},
  errors: {},

  startDownload(model_id, opts) {
    const running = inflight.get(model_id);
    if (running) return running;
    const p = runDownload(model_id, opts).finally(() => inflight.delete(model_id));
    inflight.set(model_id, p);
    return p;
  },

  async cancelDownload(model_id) {
    try {
      await api.models.cancelDownload(model_id);
    } catch (err) {
      handleError(err, "Could not cancel the download");
    }
    await handles.get(model_id)?.cancel();
  },


  async verify(model_id) {
    set((s) => ({ busy: { ...s.busy, [model_id]: "verify" } }));
    try {
      const r = await api.models.verify(model_id);
      if (r.ok) toast.success("Model verified", `${model_id} · revision ${r.revision ?? "unknown"}`);
      else toast.warning("Model incomplete", `Missing: ${r.missing_files.join(", ") || "unknown files"}`);
      void useAppStore.getState().loadModels();
      return r;
    } catch (err) {
      handleError(err, "Verification failed");
      return null;
    } finally {
      set((s) => ({ busy: { ...s.busy, [model_id]: undefined } }));
    }
  },

  async useExistingDir(model_id) {
    let path: string | null = null;
    try {
      path = await api.shell.pickDirectory();
    } catch (err) {
      handleError(err, "Could not open the folder picker");
      return false;
    }
    if (!path) return false;
    set((s) => ({ busy: { ...s.busy, [model_id]: "use_existing" } }));
    try {
      const r = await api.models.useExistingDir({ model_id, path });
      if (r.ok) toast.success("Folder linked", r.warnings.length ? r.warnings.join("\n") : `${model_id} now uses ${path}`);
      else toast.warning("Folder not accepted", r.warnings.join("\n") || "The folder does not contain the expected files.");
      void useAppStore.getState().loadModels();
      void useAppStore.getState().loadEngines();
      return r.ok;
    } catch (err) {
      handleError(err, "Could not use that folder");
      return false;
    } finally {
      set((s) => ({ busy: { ...s.busy, [model_id]: undefined } }));
    }
  },

  async remove(model_id) {
    set((s) => ({ busy: { ...s.busy, [model_id]: "remove" } }));
    try {
      await api.models.remove(model_id);
      toast.success("Model removed", model_id);
      void useAppStore.getState().loadModels();
      void useAppStore.getState().loadEngines();
      return true;
    } catch (err) {
      handleError(err, "Could not remove the model");
      return false;
    } finally {
      set((s) => ({ busy: { ...s.busy, [model_id]: undefined } }));
    }
  },

  async loadEngine(engine_id) {
    set((s) => ({ busy: { ...s.busy, [engine_id]: "load" } }));
    try {
      const r = await api.engine.load(
        { engine_id },
        {
          onProgress: (p) => {
            const prev = useAppStore.getState().engineStates[engine_id];
            useAppStore.getState().applyEngineState({ ...prev, engine_id, state: "loading", message: p.message });
          },
        },
      );
      toast.success(r.already_loaded ? "Engine already loaded" : "Engine loaded", `${engine_id} · ${r.model_id}${r.load_ms ? ` in ${(r.load_ms / 1000).toFixed(1)} s` : ""}`);
      void useAppStore.getState().loadEngines();
      return true;
    } catch (err) {
      handleError(err, "Could not load the engine");
      void useAppStore.getState().loadEngines();
      return false;
    } finally {
      set((s) => ({ busy: { ...s.busy, [engine_id]: undefined } }));
    }
  },

  async unloadEngine(engine_id) {
    set((s) => ({ busy: { ...s.busy, [engine_id]: "unload" } }));
    try {
      await api.engine.unload(engine_id);
      void useAppStore.getState().loadEngines();
      return true;
    } catch (err) {
      handleError(err, "Could not unload the engine");
      return false;
    } finally {
      set((s) => ({ busy: { ...s.busy, [engine_id]: undefined } }));
    }
  },
}));


/** One download through the worker (progress in measured bytes, verification, resumable); errors are kept per model. */
async function runDownload(model_id: string, opts?: { quiet?: boolean }): Promise<boolean> {
  const set = useModelOps.setState;
  set((s) => ({ errors: { ...s.errors, [model_id]: undefined } }));
  const req = api.models.download(model_id, {
    onProgress: (p) =>
      set((s) => {
        const job = s.downloads[model_id];
        if (!job) return s;
        return {
          downloads: {
            ...s.downloads,
            [model_id]: {
              ...job,
              stage: p.stage,
              message: p.message,
              bytes_done: p.detail?.bytes_done ?? (p.stage === "download" ? (p.current ?? job.bytes_done) : job.bytes_done),
              bytes_total: p.detail?.bytes_total ?? (p.stage === "download" ? (p.total ?? job.bytes_total) : job.bytes_total),
              current: p.current ?? null,
              total: p.total ?? null,
            },
          },
        };
      }),
  });
  handles.set(model_id, req);
  set((s) => ({
    downloads: { ...s.downloads, [model_id]: { model_id, request_id: req.id, stage: "queued", message: "Starting download", bytes_done: null, bytes_total: null, current: null, total: null } },
  }));
  try {
    const r = await req;
    if (!opts?.quiet) toast.success("Model installed", `${r.model_id} (${r.revision.slice(0, 12)})`);
    return true;
  } catch (err) {
    const we = opts?.quiet ? WorkerError.from(err) : handleError(err, "Model download failed");
    if (!we.cancelled) set((s) => ({ errors: { ...s.errors, [model_id]: we } }));
    else if (!opts?.quiet) toast.info("Download cancelled", model_id);
    return false;
  } finally {
    handles.delete(model_id);
    set((s) => {
      const { [model_id]: _drop, ...rest } = s.downloads;
      return { downloads: rest };
    });
    void useAppStore.getState().loadModels();
    void useAppStore.getState().loadEngines();
  }
}
