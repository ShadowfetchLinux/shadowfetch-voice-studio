/**
 * The Speak screen: one text, one voice, one button.
 *
 * `speak()` runs the regular project pipeline on the hidden scratch project, start to finish:
 *   tts.plan → tts.generate (only sentences that changed, or everything when the text and voice are exactly what was
 *   spoken last — "say it again") → tts.assemble → speak.remember (own file for Recent) → auto-play.
 *
 * Rules kept here:
 * - One run at a time; repeated presses (button, Ctrl+Enter) while a run is active are ignored.
 * - Each run snapshots the text and voice it started with; editing while it runs never mixes versions.
 * - Stop cancels through the worker's cancellation (finished sentences are kept for the next run).
 * - Text is autosaved to the scratch project (script versions) and mirrored in localStorage until the worker has it.
 */
import { create } from "zustand";
import { api } from "@/lib/api";
import type { Progress, SpeechEntry, Voice } from "@/lib/protocol";
import { WorkerError } from "@/lib/protocol";
import { friendlyError, logWorkerError, type FriendlyError } from "@/lib/friendlyErrors";
import { useAppStore } from "@/store/appStore";
import { ensureModels, speakEngineId, useModelSetup } from "@/store/modelSetup";
import { useVoicesStore } from "@/store/voicesStore";
import { clampMaxChars, controlValues, pickLanguage } from "@/features/create/planMath";

export const SAVE_DEBOUNCE_MS = 800;
export const DRAFT_KEY = "sfvs.speak.draft";
const HISTORY_SHOWN = 10;
/** The worker keeps this many results (speak.remember `keep`); older files are pruned. */
const HISTORY_MAX = 30;

export type SpeakStep = "prepare" | "queued" | "load" | "voice" | "generate" | "finish";

export interface SpeakRun {
  id: number;
  step: SpeakStep;
  current: number | null;
  total: number | null;
  cancelling: boolean;
  /** Worker request that can be cancelled right now (generate / plan / assemble). */
  requestId: string | null;
}

/** Advanced overrides stored on the scratch project (`project.settings.speak`). */
export interface SpeakOverrides {
  engine_id?: string | null;
  language?: string | null;
}

interface SpeakState {
  ready: boolean;
  loadError: FriendlyError | null;
  projectId: string | null;
  text: string;
  savedText: string;
  saveState: "saved" | "dirty" | "saving" | "error";
  voiceId: string | null;
  /** scratch project settings: {plan, controls, seed, speak:{engine_id, language}} */
  projectSettings: Record<string, unknown>;
  engineOverride: string | null;
  run: SpeakRun | null;
  error: FriendlyError | null;
  /** Speak was pressed without a usable voice. */
  needsVoice: boolean;
  current: SpeechEntry | null;
  history: SpeechEntry[];
  /** Id of the result that should start playing as soon as its player is ready (auto-play or a Recent click).
   *  Tied to an id so a player still showing an older result can never act on it. */
  playRequest: string | null;
  lastSpoken: { text: string; voiceId: string | null; engineId: string | null } | null;
  /** Bumped to put the cursor back in the editor (e.g. after a voice was created in a dialog). */
  focusToken: number;

  init: () => Promise<void>;
  setText: (text: string) => void;
  flushText: () => Promise<void>;
  setVoice: (voiceId: string | null) => Promise<void>;
  speak: () => Promise<boolean>;
  cancel: () => Promise<void>;
  play: (entry: SpeechEntry) => void;
  /** The player started (or gave up on) the requested playback. */
  consumePlay: (entryId: string) => void;
  forget: (entry: SpeechEntry) => Promise<void>;
  loadHistory: (limit?: number) => Promise<void>;
  dismissError: () => void;
  /** Re-read the scratch project's advanced settings after Settings changed them. */
  refreshProjectSettings: () => Promise<void>;
  requestEditorFocus: () => void;
}

// ---------------------------------------------------------------- draft mirror (localStorage)
interface Draft {
  text: string;
  projectId: string | null;
  saved: boolean;
  at: number;
}

function readDraft(): Draft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    return typeof d?.text === "string" ? d : null;
  } catch {
    return null;
  }
}

function writeDraft(d: Draft): void {
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    // storage full / disabled: the worker copy is the source of truth anyway
  }
}

let saveTimer: number | null = null;
let savePromise: Promise<void> | null = null;
let initPromise: Promise<void> | null = null;
/** A voice chosen while a Speak was running (e.g. just created): applied as soon as the run ends. */
let pendingVoiceId: string | null = null;
/**
 * A "say it again" (fresh reading of everything) that was stopped or failed part-way: which segments already got
 * their new reading. Pressing Speak again with the same text, voice and engine continues with the rest instead of
 * starting over — finished sentences are kept, as the Stop button promises.
 */
let interrupted: { key: string; done: Set<number> } | null = null;
let runCounter = 0;

function clearSaveTimer() {
  if (saveTimer != null) window.clearTimeout(saveTimer);
  saveTimer = null;
}

/** Map a worker progress event to the step the Speak button shows. */
export function stepFromProgress(p: Progress): Pick<SpeakRun, "step" | "current" | "total"> {
  switch (p.stage) {
    case "queued":
      return { step: "queued", current: null, total: null };
    case "engine":
      return { step: "load", current: null, total: null };
    case "prepare":
      return { step: "voice", current: null, total: null };
    case "generate":
      return { step: "generate", current: p.current ?? null, total: p.total ?? null };
    default:
      return { step: "generate", current: p.current ?? null, total: p.total ?? null };
  }
}

/** What the Speak button says while working. */
export function stepLabel(run: SpeakRun | null): string {
  if (!run) return "Speak";
  if (run.cancelling) return "Stopping…";
  switch (run.step) {
    case "queued":
      return "Waiting for another task…";
    case "load":
      return "Loading the voice model…";
    case "voice":
      return "Getting the voice ready…";
    case "finish":
      return "Finishing…";
    case "generate":
      return run.total != null && run.total > 1 && run.current != null ? `Generating speech — ${run.current} of ${run.total}` : "Generating speech…";
    default:
      return "Generating speech…";
  }
}

function overridesOf(settings: Record<string, unknown>): SpeakOverrides {
  const s = settings.speak;
  return s && typeof s === "object" ? (s as SpeakOverrides) : {};
}

export const useSpeakStore = create<SpeakState>((set, get) => {
  const saveNow = async (): Promise<void> => {
    const { projectId, text, savedText } = get();
    if (!projectId || text === savedText) return;
    set({ saveState: "saving" });
    try {
      await api.projects.saveScript({ id: projectId, text });
      const now = get();
      set({ savedText: text, saveState: now.text === text ? "saved" : "dirty" });
      if (now.text === text) writeDraft({ text, projectId, saved: true, at: Date.now() });
      else scheduleSave();
    } catch (err) {
      logWorkerError("speak.autosave", err);
      set({ saveState: "error" });
    }
  };

  const scheduleSave = () => {
    clearSaveTimer();
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      savePromise = saveNow().finally(() => {
        savePromise = null;
      });
    }, SAVE_DEBOUNCE_MS);
  };

  const pickDefaultVoice = (voices: Voice[], preferred: string | null): string | null => {
    const usable = voices.filter((v) => !v.archived && (v.references?.length ?? 0) > 0);
    if (preferred && usable.some((v) => v.id === preferred)) return preferred;
    return usable[0]?.id ?? null;
  };

  const isCurrentRun = (id: number) => get().run?.id === id;

  const loadSession = async (): Promise<void> => {
    try {
      const [session, voices] = await Promise.all([api.speak.session({ history_limit: HISTORY_SHOWN }), useVoicesStore.getState().load()]);
      const draft = readDraft();
      // An edit that never reached the worker (app closed within the autosave delay, or the worker was down) wins.
      const useDraft = draft != null && !draft.saved && draft.text !== session.text && (draft.projectId == null || draft.projectId === session.project_id);
      const text = useDraft ? draft.text : session.text;
      const voiceId = pickDefaultVoice(voices, session.voice_id);
      const last = session.history[0] ?? null;
      set({
        ready: true,
        loadError: null,
        projectId: session.project_id,
        text,
        savedText: session.text,
        saveState: useDraft ? "dirty" : "saved",
        voiceId,
        projectSettings: session.settings ?? {},
        engineOverride: overridesOf(session.settings ?? {}).engine_id ?? null,
        history: session.history,
        current: last,
        lastSpoken: last ? { text: last.text, voiceId: last.voice_id, engineId: last.engine_id } : null,
      });
      if (useDraft) scheduleSave();
      if (voiceId && voiceId !== session.voice_id) void api.projects.update({ id: session.project_id, patch: { voice_id: voiceId } }).catch((e) => logWorkerError("speak.voice", e));
    } catch (err) {
      logWorkerError("speak.session", err);
      set({ ready: true, loadError: friendlyError(err, "general") });
    }
  };

  return {
    ready: false,
    loadError: null,
    projectId: null,
    text: "",
    savedText: "",
    saveState: "saved",
    voiceId: null,
    projectSettings: {},
    engineOverride: null,
    run: null,
    error: null,
    needsVoice: false,
    current: null,
    history: [],
    playRequest: null,
    lastSpoken: null,
    focusToken: 0,

    init() {
      // One load at a time: the app shell, the Speak page and Settings may all ask for it.
      if (!initPromise) initPromise = loadSession().finally(() => (initPromise = null));
      return initPromise;
    },

    setText(text) {
      const { projectId, savedText } = get();
      set({ text, saveState: text === savedText ? "saved" : "dirty", needsVoice: false });
      writeDraft({ text, projectId, saved: text === savedText, at: Date.now() });
      if (text !== savedText) scheduleSave();
      else clearSaveTimer();
    },

    async flushText() {
      if (saveTimer != null) {
        clearSaveTimer();
        await saveNow();
      } else if (savePromise) {
        await savePromise;
      }
    },

    async setVoice(voiceId) {
      if (get().run) {
        // the running job keeps the voice it started with; take this one next
        pendingVoiceId = voiceId;
        return;
      }
      // Picked before the session finished loading (e.g. "Use Voice" right after launch): load first, so the
      // remembered voice cannot overwrite this choice afterwards.
      if (!get().ready) await get().init();
      const { projectId } = get();
      set({ voiceId, needsVoice: false, error: null });
      if (!projectId || !voiceId) return;
      try {
        await api.projects.update({ id: projectId, patch: { voice_id: voiceId } });
      } catch (err) {
        logWorkerError("speak.voice", err);
      }
    },

    async speak() {
      const s0 = get();
      if (s0.run || !s0.ready) return false;
      if (!s0.projectId) {
        // the session did not load (worker was down): say so and try again
        set({ error: friendlyError(new WorkerError({ code: "INTERNAL", message: "The Speak session is not loaded." }), "speak") });
        void get().init();
        return false;
      }
      const text = s0.text;
      if (!text.trim()) return false;
      const voices = useVoicesStore.getState().voices;
      const voice = voices.find((v) => v.id === s0.voiceId) ?? null;
      const referenceId = voice?.selected_reference_id ?? voice?.references?.[voice.references.length - 1]?.id ?? null;
      if (!voice || !referenceId) {
        set({ needsVoice: true, error: null });
        return false;
      }
      const id = ++runCounter;
      const projectId = s0.projectId;
      set({ run: { id, step: "prepare", current: null, total: null, cancelling: false, requestId: null }, error: null, needsVoice: false });

      const fail = (err: unknown): false => {
        if (!isCurrentRun(id)) return false;
        const we = WorkerError.from(err);
        logWorkerError("speak", we);
        set({ run: null, error: we.cancelled ? null : friendlyError(we, "speak") });
        if (we.code === "MODEL_MISSING" || we.code === "MODEL_INVALID") void useAppStore.getState().loadModels();
        return false;
      };
      const stopped = () => !isCurrentRun(id) || get().run?.cancelling === true;

      try {
        // 0. engine and model lists (right after launch they may still be loading): without them the engine's
        //    declared settings are unknown, and the readiness check below would guess
        const app0 = useAppStore.getState();
        if (!app0.engines.length) await app0.loadEngines();
        if (!app0.models.length) await app0.loadModels();
        if (stopped()) return fail(new WorkerError({ code: "CANCELLED", message: "Stopped" }));
        // 1. the local model must be there (friendly setup dialog otherwise; the run continues once installed)
        const overrides = overridesOf(get().projectSettings);
        if (!(await ensureModels("speak", overrides.engine_id ?? null))) {
          if (isCurrentRun(id)) set({ run: null });
          return false;
        }
        if (stopped()) return fail(new WorkerError({ code: "CANCELLED", message: "Stopped" }));
        const app = useAppStore.getState();
        const engineId = speakEngineId(app.engines, app.settings, overrides.engine_id ?? null);
        if (!engineId) return fail(new WorkerError({ code: "ENGINE_UNAVAILABLE", message: "No speech engine is installed." }));
        const caps = app.engines.find((e) => e.id === engineId)?.capabilities ?? null;
        const ps = get().projectSettings;
        const controls = controlValues(caps?.controls ?? [], (ps.controls as Record<string, Record<string, unknown>> | undefined)?.[engineId]);
        const language = pickLanguage(caps, overrides.language ?? voice.language, app.settings?.default_language ?? "en");
        const seed = caps?.supports_seed && typeof ps.seed === "number" ? ps.seed : null;
        const planOpts = (ps.plan as { max_chars?: number } | undefined) ?? {};

        // 2. plan (also stores this text as the latest script version)
        await get().flushText();
        if (stopped()) return fail(new WorkerError({ code: "CANCELLED", message: "Stopped" }));
        const planReq = api.tts.plan({ project_id: projectId, script_text: text, engine_id: engineId, options: planOpts.max_chars ? { max_chars: clampMaxChars(planOpts.max_chars, caps) } : {} });
        set((s) => (s.run?.id === id ? { run: { ...s.run, requestId: planReq.id } } : s));
        const plan = await planReq;
        if (stopped()) return fail(new WorkerError({ code: "CANCELLED", message: "Stopped" }));
        if (plan.segments.length === 0) return fail(new WorkerError({ code: "INVALID_PARAMS", message: "There is nothing to say in this text." }));
        // tts.plan saved `text` as the newest script version; a newer edit made meanwhile must be saved after it.
        set((s) => ({ savedText: text, saveState: s.text === text ? "saved" : "dirty" }));
        if (get().text !== text) scheduleSave();

        // 3. generate: changed sentences only — or a fresh reading when nothing changed since the last Speak
        //    (continuing an interrupted fresh reading where it stopped)
        const last = get().lastSpoken;
        const key = `${text}\u0000${voice.id}\u0000${engineId}`;
        const resume = interrupted?.key === key ? interrupted : null;
        const again = !resume && last != null && last.text === text && last.voiceId === voice.id && last.engineId === engineId;
        const remaining = resume ? plan.segments.map((sg) => sg.index).filter((i) => !resume.done.has(i)) : [];
        const mode = resume && remaining.length ? { segment_indices: remaining } : again ? { regenerate_all: true } : { only_changed: true };
        const genReq = api.tts.generate(
          { project_id: projectId, engine_id: engineId, reference_id: referenceId, language, settings: controls, ...(seed != null ? { seed } : {}), ...mode },
          {
            onProgress: (p) =>
              set((s) => (s.run?.id === id && !s.run.cancelling ? { run: { ...s.run, ...stepFromProgress(p) } } : s)),
          },
        );
        set((s) => (s.run?.id === id ? { run: { ...s.run, requestId: genReq.id, step: s.run.step === "prepare" ? "generate" : s.run.step } } : s));
        try {
          await genReq;
          interrupted = null;
        } catch (err) {
          if (again || resume) {
            const completed = WorkerError.from(err).details.completed;
            const done = new Set(resume?.done ?? []);
            if (Array.isArray(completed)) for (const c of completed) if (typeof (c as { segment_index?: unknown }).segment_index === "number") done.add((c as { segment_index: number }).segment_index);
            interrupted = { key, done };
          }
          throw err;
        }
        if (stopped()) return fail(new WorkerError({ code: "CANCELLED", message: "Stopped" }));

        // 4. assemble + keep
        set((s) => (s.run?.id === id ? { run: { ...s.run, step: "finish", current: null, total: null, requestId: null } } : s));
        await api.tts.assemble({ project_id: projectId });
        if (stopped()) return fail(new WorkerError({ code: "CANCELLED", message: "Stopped" }));
        const entry = await api.speak.remember({ project_id: projectId, text, voice_id: voice.id, keep: HISTORY_MAX });
        if (!isCurrentRun(id)) return false;
        // Stop pressed during the last step: keep the finished result, but do not start playing it. Nor when the
        // user has moved to another screen — the result waits in the player on Speak.
        const autoplay = get().run?.cancelling !== true && (useAppStore.getState().settings?.speak_autoplay ?? true) && useAppStore.getState().page === "speak";
        set((s) => ({
          run: null,
          current: entry,
          history: [entry, ...s.history.filter((h) => h.id !== entry.id)].slice(0, HISTORY_MAX),
          playRequest: autoplay ? entry.id : null,
          lastSpoken: { text, voiceId: voice.id, engineId },
        }));
        return true;
      } catch (err) {
        return fail(err);
      } finally {
        if (pendingVoiceId && !get().run) {
          const next = pendingVoiceId;
          pendingVoiceId = null;
          void get().setVoice(next);
        }
      }
    },

    async cancel() {
      const run = get().run;
      if (!run || run.cancelling) return;
      set({ run: { ...run, cancelling: true } });
      if (useModelSetup.getState().open) useModelSetup.getState().finish(false);
      if (run.requestId) await api.cancel(run.requestId);
    },

    play(entry) {
      set({ current: entry, playRequest: entry.id });
    },

    consumePlay(entryId) {
      if (get().playRequest === entryId) set({ playRequest: null });
    },

    async forget(entry) {
      try {
        await api.speak.forget(entry.id);
      } catch (err) {
        logWorkerError("speak.forget", err);
      }
      set((s) => ({ history: s.history.filter((h) => h.id !== entry.id), current: s.current?.id === entry.id ? null : s.current, playRequest: s.playRequest === entry.id ? null : s.playRequest }));
    },

    async loadHistory(limit = HISTORY_MAX) {
      try {
        const r = await api.speak.history({ limit });
        set({ history: r.history });
      } catch (err) {
        logWorkerError("speak.history", err);
      }
    },

    dismissError: () => set({ error: null, needsVoice: false }),

    requestEditorFocus: () => set((s) => ({ focusToken: s.focusToken + 1 })),

    async refreshProjectSettings() {
      try {
        const s = await api.speak.session({ history_limit: 0 });
        set({ projectSettings: s.settings ?? {}, engineOverride: overridesOf(s.settings ?? {}).engine_id ?? null });
      } catch (err) {
        logWorkerError("speak.settings", err);
      }
    },
  };
});

/** Test/reset hook. */
export function __resetSpeakStore(): void {
  clearSaveTimer();
  savePromise = null;
  initPromise = null;
  pendingVoiceId = null;
  interrupted = null;
  runCounter = 0;
  useSpeakStore.setState(useSpeakStore.getInitialState(), true);
}
