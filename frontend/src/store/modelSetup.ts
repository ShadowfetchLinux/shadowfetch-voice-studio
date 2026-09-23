/**
 * "Voice Studio needs its local model" — one friendly gate in front of Speak and Clone Voice.
 *
 * `ensureModels(purpose)` checks what that action needs; when something is missing it opens the setup dialog and
 * resolves once everything is installed (true) or the user closes the dialog (false). Downloads still go through the
 * model manager (sizes, source, license, approval, offline mode, verification, pinned revisions).
 */
import { create } from "zustand";
import type { EngineInfo, ModelInfo, Settings } from "@/lib/protocol";
import { useAppStore } from "./appStore";

export type SetupPurpose = "speak" | "clone";

export interface ModelNeed {
  model: ModelInfo;
  /** Human name ("Voice model", "Speech recognition"). */
  role: string;
  /** Where it runs, in plain words. */
  runsOn: string;
  /** Strictly required for this action (false = also needed soon, offered alongside). */
  required: boolean;
}

export interface Readiness {
  /** Models to download (missing / incomplete / errored). */
  needs: ModelNeed[];
  /** The engine's Python environment is not installed: downloads cannot fix it — the system check can. */
  engineMissing: EngineInfo | null;
  /** Everything this action needs is present (or unknown yet — the worker will say so if not). */
  ready: boolean;
}

/** The engine Speak uses: the scratch project's override when installed, else the app default, else any installed one. */
export function speakEngineId(engines: EngineInfo[], settings: Settings | null, preferred?: string | null): string | null {
  const usable = (id?: string | null) => (id ? engines.find((e) => e.id === id && e.installed) : undefined);
  return (usable(preferred) ?? usable(settings?.default_engine) ?? engines.find((e) => e.installed && !e.optional) ?? engines.find((e) => e.installed))?.id ??
    settings?.default_engine ?? null;
}

/** Not usable yet: missing, incomplete, errored — or still downloading / verifying (the worker refuses it until then). */
function isMissing(m: ModelInfo | undefined): boolean {
  return !!m && m.state !== "installed";
}

/** Pure: what a purpose needs, given the current engine/model lists. Unknown lists (not loaded yet) count as ready. */
export function readiness(purpose: SetupPurpose, engines: EngineInfo[], models: ModelInfo[], settings: Settings | null, preferredEngine?: string | null): Readiness {
  const needs: ModelNeed[] = [];
  const engineId = speakEngineId(engines, settings, preferredEngine);
  const engine = engines.find((e) => e.id === engineId) ?? null;
  const ttsModel = engine ? models.find((m) => m.engine_id === engine.id && m.kind === "tts") : undefined;
  const asrModel = models.find((m) => m.id === settings?.asr_model && m.kind === "asr");
  const asrOnGpu = settings?.asr_device === "cuda";
  if (purpose === "clone" && isMissing(asrModel)) {
    needs.push({ model: asrModel!, role: "Speech recognition", runsOn: asrOnGpu ? "Runs locally on your NVIDIA GPU." : "Runs locally on your processor.", required: true });
  }
  if (isMissing(ttsModel)) {
    needs.push({ model: ttsModel!, role: "Voice model", runsOn: "Runs locally on your NVIDIA GPU.", required: purpose === "speak" });
  }
  const engineMissing = purpose === "speak" && engine && !engine.installed ? engine : null;
  return { needs, engineMissing, ready: !engineMissing && needs.every((n) => !n.required) };
}

interface ModelSetupState {
  open: boolean;
  purpose: SetupPurpose;
  /** Resolves the pending `ensureModels` call. */
  resolve: ((ok: boolean) => void) | null;
  show: (purpose: SetupPurpose) => Promise<boolean>;
  finish: (ok: boolean) => void;
}

export const useModelSetup = create<ModelSetupState>((set, get) => ({
  open: false,
  purpose: "speak",
  resolve: null,
  show(purpose) {
    get().resolve?.(false);
    return new Promise<boolean>((resolve) => set({ open: true, purpose, resolve }));
  },
  finish(ok) {
    const r = get().resolve;
    set({ open: false, resolve: null });
    r?.(ok);
  },
}));

/** Check readiness for an action; open the setup dialog when a required model is missing. */
export async function ensureModels(purpose: SetupPurpose, preferredEngine?: string | null): Promise<boolean> {
  const app = useAppStore.getState();
  const r = readiness(purpose, app.engines, app.models, app.settings, preferredEngine);
  if (r.ready) return true;
  return useModelSetup.getState().show(purpose);
}
