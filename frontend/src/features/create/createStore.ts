/**
 * Create page state (zustand). Holds the open project, the script, the plan with takes, generation jobs and
 * their progress, and the per-project settings that are persisted through `projects.update`.
 *
 * Rules kept here:
 * - Progress counts come straight from worker progress events (never invented).
 * - A cancelled/failed `tts.generate` keeps every completed take (`error.details.completed`).
 * - Only controls the selected engine declared are ever sent (`controlValues`).
 */
import { create } from "zustand";
import { api } from "@/lib/api";
import type { Capabilities, GeneratedTake, MasterInfo, Progress, Project, Take, TtsGenerateResult, Voice } from "@/lib/protocol";
import { WorkerError } from "@/lib/protocol";
import { useAppStore } from "@/store/appStore";
import {
  clampMaxChars,
  controlValues,
  normalizeProjectDetail,
  pickLanguage,
  planOptionsFrom,
  statusFromTakes,
  toSegmentView,
} from "./planMath";
import type { ActiveJob, CompareEntry, CompareState, CreateError, GenerateRequest, JobKind, PlanOptionsState, SaveState, SegmentView, TextRange } from "./types";

export const AUTOSAVE_DEBOUNCE_MS = 1500;
const SETTINGS_DEBOUNCE_MS = 800;

export interface CreateState {
  // project
  projects: Project[];
  projectId: string | null;
  project: Project | null;
  projectLoading: boolean;
  voices: Voice[];

  // script
  script: string;
  savedScript: string;
  saveState: SaveState;
  scriptVersion: number | null;
  selection: TextRange | null;

  // plan
  segments: SegmentView[];
  planVersion: number;
  planWarnings: string[];
  planNotes: string[];

  // generation setup (mirrors project columns + project.settings)
  engineId: string | null;
  voiceId: string | null;
  referenceId: string | null;
  language: string;
  controls: Record<string, Record<string, unknown>>;
  postProcessing: Record<string, Record<string, unknown>>;
  seed: number | null;
  plan: PlanOptionsState;

  // master
  masterPath: string | null;
  master: MasterInfo | null;

  // jobs
  job: ActiveJob | null;
  error: CreateError | null;
  notice: string | null;
  compare: CompareState | null;

  // ui
  drawerSegment: number | null;
  previewTake: { path: string; label: string; nonce: number } | null;
  segmentationOpen: boolean;
  setSegmentationOpen: (open: boolean) => void;

  // actions: project
  loadProjects: () => Promise<Project[]>;
  loadVoices: () => Promise<Voice[]>;
  openProject: (id: string) => Promise<boolean>;
  createProject: (name: string) => Promise<Project | null>;
  renameProject: (name: string) => Promise<void>;
  closeProject: () => void;

  // actions: script
  setScript: (text: string) => void;
  setSelection: (sel: TextRange | null) => void;
  saveScriptNow: () => Promise<void>;
  importTextFile: () => Promise<void>;

  // actions: setup
  setEngine: (engineId: string) => void;
  setVoice: (voiceId: string | null, referenceId: string | null) => Promise<void>;
  setLanguage: (code: string) => void;
  setControl: (engineId: string, id: string, value: unknown) => void;
  setPostProcessing: (engineId: string, id: string, value: unknown) => void;
  setSeed: (seed: number | null) => void;
  setPlanOption: <K extends keyof PlanOptionsState>(key: K, value: PlanOptionsState[K]) => void;

  // actions: jobs
  runPlan: () => Promise<boolean>;
  generate: (req: GenerateRequest) => Promise<boolean>;
  cancelJob: () => Promise<void>;
  assemble: () => Promise<boolean>;
  compareEngines: (engineIds: string[], segmentIndex: number) => Promise<boolean>;
  selectTake: (segmentIndex: number, takeId: string) => Promise<void>;
  retry: () => Promise<void>;
  dismissError: () => void;

  // actions: ui
  openDrawer: (segmentIndex: number | null) => void;
  playTake: (path: string, label: string) => void;
  stopTakePreview: () => void;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function defaultPlanOptions(): PlanOptionsState {
  const s = useAppStore.getState().settings;
  return {
    max_chars: s?.max_chars_per_segment ?? 400,
    paragraph_pause_ms: s?.paragraph_pause_ms ?? 600,
    sentence_pause_ms: s?.sentence_pause_ms ?? 250,
    pronunciation: [],
    spell_numbers: false,
  };
}

/** Capabilities of an engine from the app store's `engine.list` snapshot (installed engines carry them). */
export function capsFor(engineId: string | null | undefined): Capabilities | null {
  if (!engineId) return null;
  return useAppStore.getState().engines.find((e) => e.id === engineId)?.capabilities ?? null;
}

function toError(err: unknown, context: CreateError["context"], retry: GenerateRequest | null = null): CreateError {
  const we = WorkerError.from(err);
  const completed = Array.isArray(we.details.completed) ? (we.details.completed as unknown[]).length : 0;
  return { code: we.code, message: we.message, details: we.details, recoverable: we.recoverable, context, retry, completed };
}

function takeFromGenerated(t: GeneratedTake, seg: SegmentView, projectId: string, engineId: string, label: string | undefined): Take {
  return {
    id: t.take_id,
    segment_id: seg.id ?? "",
    project_id: projectId,
    engine_id: engineId,
    path: t.path,
    duration_s: t.duration_s ?? null,
    seed: t.seed ?? null,
    sample_rate: (t as GeneratedTake & { sample_rate?: number | null }).sample_rate ?? null,
    label: label ?? null,
    status: "ok",
    created_at: new Date().toISOString(),
  };
}

/** Merge generated takes into the segment list: each take becomes the selected take of its segment. */
export function mergeGeneratedTakes(segments: SegmentView[], takes: readonly GeneratedTake[], projectId: string, engineId: string, label?: string): SegmentView[] {
  const byIndex = new Map(takes.map((t) => [t.segment_index, t] as const));
  return segments.map((s) => {
    const t = byIndex.get(s.index);
    if (!t) return s;
    const take = takeFromGenerated(t, s, projectId, engineId, label);
    const others = s.takes.filter((x) => x.id !== take.id);
    return { ...s, takes: [...others, take], selected_take_id: take.id, status: "ok", error: null };
  });
}

/** Reset transient statuses (queued/generating) back to what the persisted takes imply. */
function settleSegments(segments: SegmentView[], failedIndex: number | null, failedMessage: string | null): SegmentView[] {
  return segments.map((s) => {
    if (s.status !== "queued" && s.status !== "generating") return s;
    if (failedIndex != null && s.index === failedIndex && failedMessage != null) return { ...s, status: "failed", error: failedMessage };
    return { ...s, status: statusFromTakes(s.takes, s.selected_take_id), error: null };
  });
}

let settingsTimer: number | null = null;
let settingsVersion = 0;

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export const useCreateStore = create<CreateState>((set, get) => {
  const persistSettings = () => {
    const id = get().projectId;
    if (!id) return;
    if (settingsTimer != null) window.clearTimeout(settingsTimer);
    const version = ++settingsVersion;
    settingsTimer = window.setTimeout(() => {
      settingsTimer = null;
      if (version !== settingsVersion || get().projectId !== id) return;
      const { plan, controls, postProcessing, seed } = get();
      void api.projects.update({ id, patch: { settings: { plan, controls, post_processing: postProcessing, seed } } }).catch((err) => {
        console.warn("could not persist project settings", err);
      });
    }, SETTINGS_DEBOUNCE_MS);
  };

  const patchProject = async (patch: Parameters<typeof api.projects.update>[0]["patch"]) => {
    const id = get().projectId;
    if (!id) return;
    try {
      const p = await api.projects.update({ id, patch });
      set((s) => ({ project: s.projectId === id ? { ...s.project, ...p } : s.project, projects: s.projects.map((x) => (x.id === id ? { ...x, ...p } : x)) }));
    } catch (err) {
      set({ error: toError(err, "project") });
    }
  };

  const refreshProject = async () => {
    const id = get().projectId;
    if (!id) return;
    try {
      const raw = await api.projects.get(id);
      if (get().projectId !== id) return;
      const v = normalizeProjectDetail(raw);
      set((s) => ({
        project: v.project,
        segments: s.job ? s.segments : v.segments,
        planVersion: v.project.plan_version,
        masterPath: v.project.master_path ?? null,
        master: v.project.master ?? null,
      }));
    } catch (err) {
      console.warn("projects.get refresh failed", err);
    }
  };

  const startJob = (kind: JobKind, label: string, requestId: string, request: GenerateRequest | null): ActiveJob => {
    const job: ActiveJob = { kind, requestId, label, stage: "queued", message: "Waiting for the worker", current: null, total: null, segmentIndex: null, startedAt: Date.now(), cancelling: false, request };
    set({ job, error: null, notice: null });
    return job;
  };

  const onJobProgress = (p: Progress) => {
    set((s) => {
      if (!s.job || s.job.requestId !== p.id) return s;
      const segIdx = typeof p.detail?.segment_index === "number" ? (p.detail.segment_index as number) : null;
      const segments = segIdx == null ? s.segments : s.segments.map((seg) => (seg.index === segIdx && seg.status === "queued" ? { ...seg, status: "generating" as const } : seg));
      return { job: { ...s.job, stage: p.stage, message: p.message, current: p.current ?? null, total: p.total ?? null, segmentIndex: segIdx ?? s.job.segmentIndex }, segments };
    });
  };

  return {
    projects: [],
    projectId: null,
    project: null,
    projectLoading: false,
    voices: [],
    script: "",
    savedScript: "",
    saveState: "idle",
    scriptVersion: null,
    selection: null,
    segments: [],
    planVersion: 0,
    planWarnings: [],
    planNotes: [],
    engineId: null,
    voiceId: null,
    referenceId: null,
    language: "en",
    controls: {},
    postProcessing: {},
    seed: null,
    plan: defaultPlanOptions(),
    masterPath: null,
    master: null,
    job: null,
    error: null,
    notice: null,
    compare: null,
    drawerSegment: null,
    previewTake: null,
    segmentationOpen: false,
    setSegmentationOpen: (open) => set({ segmentationOpen: open }),

    // ----------------------------------------------------------------- project
    async loadProjects() {
      try {
        const r = await api.projects.list({ sort: "updated" });
        set({ projects: r.projects });
        return r.projects;
      } catch (err) {
        set({ error: toError(err, "project") });
        return [];
      }
    },

    async loadVoices() {
      try {
        const r = await api.voices.list();
        set({ voices: r.voices });
        return r.voices;
      } catch (err) {
        set({ error: toError(err, "project") });
        return [];
      }
    },

    async openProject(id) {
      set({ projectLoading: true, error: null, notice: null, compare: null, drawerSegment: null, previewTake: null });
      try {
        const raw = await api.projects.get(id);
        const v = normalizeProjectDetail(raw);
        const app = useAppStore.getState();
        const engineId = v.project.engine_id ?? app.settings?.default_engine ?? app.engines.find((e) => e.installed)?.id ?? null;
        const settings = v.project.settings ?? {};
        const controls = (settings.controls as Record<string, Record<string, unknown>> | undefined) ?? {};
        const postProcessing = (settings.post_processing as Record<string, Record<string, unknown>> | undefined) ?? {};
        const seed = typeof settings.seed === "number" ? settings.seed : null;
        const plan = planOptionsFrom(v.project, defaultPlanOptions());
        set({
          projectId: id,
          project: v.project,
          projectLoading: false,
          script: v.scriptText,
          savedScript: v.scriptText,
          saveState: "idle",
          scriptVersion: v.scriptVersion,
          selection: null,
          segments: v.segments,
          planVersion: v.project.plan_version,
          planWarnings: [],
          planNotes: [],
          engineId,
          voiceId: v.project.voice_id ?? null,
          referenceId: v.project.reference_id ?? null,
          language: pickLanguage(capsFor(engineId), v.project.language, app.settings?.default_language ?? "en"),
          controls,
          postProcessing,
          seed,
          plan: { ...plan, max_chars: clampMaxChars(plan.max_chars, capsFor(engineId)) },
          masterPath: v.project.master_path ?? null,
          master: v.project.master ?? null,
          job: null,
        });
        return true;
      } catch (err) {
        set({ projectLoading: false, error: toError(err, "project") });
        return false;
      }
    },

    async createProject(name) {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const s = get();
      try {
        const p = await api.projects.create({ name: trimmed, ...(s.engineId ? { engine_id: s.engineId } : {}), ...(s.voiceId ? { voice_id: s.voiceId } : {}) });
        set((st) => ({ projects: [p, ...st.projects] }));
        await get().openProject(p.id);
        return p;
      } catch (err) {
        set({ error: toError(err, "project") });
        return null;
      }
    },

    async renameProject(name) {
      const trimmed = name.trim();
      if (!trimmed || trimmed === get().project?.name) return;
      await patchProject({ name: trimmed });
    },

    closeProject() {
      set({ projectId: null, project: null, script: "", savedScript: "", saveState: "idle", segments: [], masterPath: null, master: null, job: null, error: null, notice: null, compare: null, drawerSegment: null });
    },

    // ------------------------------------------------------------------ script
    setScript(text) {
      set((s) => ({ script: text, saveState: text === s.savedScript ? (s.saveState === "saving" ? "saving" : "saved") : "dirty" }));
    },

    setSelection(sel) {
      const cur = get().selection;
      if (cur?.start === sel?.start && cur?.end === sel?.end) return;
      set({ selection: sel });
    },

    async saveScriptNow() {
      const { projectId, script, savedScript } = get();
      if (!projectId || script === savedScript) return;
      set({ saveState: "saving" });
      try {
        const r = await api.projects.saveScript({ id: projectId, text: script });
        if (get().projectId !== projectId) return;
        set((s) => ({ savedScript: script, scriptVersion: r.script_version, saveState: s.script === script ? "saved" : "dirty" }));
      } catch (err) {
        set({ saveState: "error", error: toError(err, "save") });
      }
    },

    async importTextFile() {
      try {
        const path = await api.shell.pickTextFile();
        if (!path) return;
        const text = await api.shell.readTextFile(path);
        get().setScript(text);
      } catch (err) {
        set({ error: toError(err, "import") });
      }
    },

    // ------------------------------------------------------------------- setup
    setEngine(engineId) {
      const caps = capsFor(engineId);
      const app = useAppStore.getState();
      set((s) => ({
        engineId,
        language: pickLanguage(caps, s.language, app.settings?.default_language ?? "en"),
        plan: { ...s.plan, max_chars: clampMaxChars(s.plan.max_chars, caps) },
      }));
      void patchProject({ engine_id: engineId, language: get().language });
      persistSettings();
    },

    async setVoice(voiceId, referenceId) {
      set({ voiceId, referenceId });
      await patchProject({ voice_id: voiceId, reference_id: referenceId });
      const p = get().project;
      if (p) set({ voiceId: p.voice_id ?? voiceId, referenceId: p.reference_id ?? referenceId });
    },

    setLanguage(code) {
      set({ language: code });
      void patchProject({ language: code });
    },

    setControl(engineId, id, value) {
      set((s) => ({ controls: { ...s.controls, [engineId]: { ...(s.controls[engineId] ?? {}), [id]: value } } }));
      persistSettings();
    },

    setPostProcessing(engineId, id, value) {
      set((s) => ({ postProcessing: { ...s.postProcessing, [engineId]: { ...(s.postProcessing[engineId] ?? {}), [id]: value } } }));
      persistSettings();
    },

    setSeed(seed) {
      set({ seed });
      persistSettings();
    },

    setPlanOption(key, value) {
      set((s) => ({ plan: { ...s.plan, [key]: key === "max_chars" ? clampMaxChars(value as number, capsFor(s.engineId)) : value } }));
      persistSettings();
    },

    // -------------------------------------------------------------------- jobs
    async runPlan() {
      const s = get();
      if (!s.projectId || s.job) return false;
      if (!s.engineId) {
        set({ error: { code: "CLIENT", message: "Pick an installed engine before planning.", details: {}, recoverable: true, context: "plan", retry: null, completed: 0 } });
        return false;
      }
      if (!s.script.trim()) {
        set({ error: { code: "CLIENT", message: "The script is empty.", details: {}, recoverable: true, context: "plan", retry: null, completed: 0 } });
        return false;
      }
      const projectId = s.projectId;
      const script = s.script;
      const req = api.tts.plan(
        { project_id: projectId, script_text: script, engine_id: s.engineId, options: { max_chars: clampMaxChars(s.plan.max_chars, capsFor(s.engineId)), paragraph_pause_ms: s.plan.paragraph_pause_ms, sentence_pause_ms: s.plan.sentence_pause_ms, pronunciation: s.plan.pronunciation.filter((r) => r.from.trim()), spell_numbers: s.plan.spell_numbers } },
        { onProgress: onJobProgress },
      );
      startJob("plan", "Planning", req.id, null);
      try {
        const r = await req;
        if (get().projectId !== projectId) return false;
        const rr = r as typeof r & { plan_version?: number; script_version?: number; normalization_notes?: string[] };
        // Segments whose text is unchanged keep their id (and takes) — carry the takes over by id.
        const prevById = new Map(get().segments.filter((x) => x.id).map((x) => [x.id as string, x] as const));
        const segments = r.segments.map((seg) => {
          const raw = seg as Parameters<typeof toSegmentView>[0];
          const prev = raw.id ? prevById.get(raw.id) : undefined;
          return toSegmentView({ ...raw, selected_take_id: raw.selected_take_id !== undefined ? raw.selected_take_id : (prev?.selected_take_id ?? null) }, prev?.takes ?? []);
        });
        set((st) => ({
          segments,
          planVersion: rr.plan_version ?? st.planVersion + 1,
          planWarnings: r.warnings ?? [],
          planNotes: rr.normalization_notes ?? [],
          savedScript: script,
          scriptVersion: rr.script_version ?? st.scriptVersion,
          saveState: st.script === script ? "saved" : "dirty",
          job: null,
          notice: `Planned ${segments.length} segment${segments.length === 1 ? "" : "s"}.`,
          compare: null,
        }));
        void refreshProject();
        return true;
      } catch (err) {
        set({ job: null, error: toError(err, "plan") });
        return false;
      }
    },

    async generate(request) {
      const s = get();
      if (!s.projectId || s.job) return false;
      const fail = (message: string) => {
        set({ error: { code: "CLIENT", message, details: {}, recoverable: true, context: "generate", retry: null, completed: 0 } });
        return false;
      };
      if (!s.engineId) return fail("Pick an installed engine first.");
      if (s.segments.length === 0) return fail("Plan the script first (Plan button).");
      const voice = s.voices.find((v) => v.id === s.voiceId);
      const referenceId = s.referenceId ?? voice?.selected_reference_id ?? null;
      if (!referenceId) return fail("This project has no voice reference yet. Pick a voice (and a reference clip) first.");
      const caps = capsFor(s.engineId);
      const controls = controlValues(caps?.controls ?? [], s.controls[s.engineId]);

      let indices: number[] | undefined;
      let label: string | undefined;
      let regenerateAll = false;
      let title = "Generate full";
      if (request.mode === "preview") {
        indices = [s.segments[0]!.index];
        label = "preview";
        title = "Generate preview";
      } else if (request.mode === "indices") {
        indices = [...new Set(request.indices ?? [])].sort((a, b) => a - b);
        if (indices.length === 0) return fail("No segments selected.");
        title = indices.length === 1 ? `Regenerate segment ${indices[0]! + 1}` : `Regenerate ${indices.length} segments`;
      } else if (request.mode === "all") {
        regenerateAll = true;
        title = "Regenerate all";
      }
      const targets = new Set(indices ?? (regenerateAll ? s.segments.map((x) => x.index) : s.segments.filter((x) => statusFromTakes(x.takes, x.selected_take_id) !== "ok").map((x) => x.index)));
      if (targets.size === 0) {
        set({ notice: "Every segment already has a take. Use Regenerate all to make new ones." });
        return false;
      }
      const projectId = s.projectId;
      const engineId = s.engineId;
      const params: Record<string, unknown> = {
        project_id: projectId,
        engine_id: engineId,
        reference_id: referenceId,
        language: s.language,
        settings: controls,
        ...(caps?.supports_seed && s.seed != null ? { seed: s.seed } : {}),
        ...(indices ? { segment_indices: indices } : {}),
        ...(label ? { take_label: label } : {}),
        ...(regenerateAll ? { regenerate_all: true } : {}),
      };
      const req = api.requestRaw<TtsGenerateResult>("tts.generate", params, { onProgress: onJobProgress });
      startJob("generate", title, req.id, request);
      set((st) => ({ segments: st.segments.map((seg) => (targets.has(seg.index) ? { ...seg, status: "queued", error: null } : seg)) }));
      try {
        const r = await req;
        if (get().projectId !== projectId) return false;
        set((st) => ({
          segments: settleSegments(mergeGeneratedTakes(st.segments, r.takes, projectId, engineId, label), null, null),
          job: null,
          notice: `Generated ${r.takes.length} take${r.takes.length === 1 ? "" : "s"} in ${r.elapsed_s.toFixed(1)} s${r.skipped.length ? ` · ${r.skipped.length} skipped (already had takes)` : ""}.`,
        }));
        void refreshProject();
        return true;
      } catch (err) {
        if (get().projectId !== projectId) return false;
        const we = WorkerError.from(err);
        const completed = Array.isArray(we.details.completed) ? (we.details.completed as GeneratedTake[]) : [];
        const failedIndex = typeof we.details.failed_segment === "number" ? (we.details.failed_segment as number) : null;
        set((st) => ({
          segments: settleSegments(mergeGeneratedTakes(st.segments, completed, projectId, engineId, label), we.cancelled ? null : failedIndex, we.cancelled ? null : we.message),
          job: null,
          error: toError(we, "generate", request),
        }));
        void refreshProject();
        return false;
      }
    },

    async cancelJob() {
      const job = get().job;
      if (!job || job.cancelling) return;
      set({ job: { ...job, cancelling: true } });
      await api.cancel(job.requestId);
    },

    async assemble() {
      const s = get();
      if (!s.projectId || s.job) return false;
      const projectId = s.projectId;
      const req = api.tts.assemble({ project_id: projectId, paragraph_pause_ms: s.plan.paragraph_pause_ms, sentence_pause_ms: s.plan.sentence_pause_ms }, { onProgress: onJobProgress });
      startJob("assemble", "Assemble", req.id, null);
      try {
        const r = await req;
        if (get().projectId !== projectId) return false;
        set({ masterPath: r.master_path, master: { duration_s: r.duration_s, sample_rate: r.sample_rate, segments_used: r.segments_used }, job: null, notice: `Master assembled: ${r.segments_used} segments, ${r.duration_s.toFixed(1)} s.` });
        void refreshProject();
        return true;
      } catch (err) {
        set({ job: null, error: toError(err, "assemble") });
        return false;
      }
    },

    async compareEngines(engineIds, segmentIndex) {
      const s = get();
      if (!s.projectId || s.job) return false;
      const projectId = s.projectId;
      const voice = s.voices.find((v) => v.id === s.voiceId);
      const referenceId = s.referenceId ?? voice?.selected_reference_id ?? null;
      const settings: Record<string, Record<string, unknown>> = {};
      for (const id of engineIds) settings[id] = controlValues(capsFor(id)?.controls ?? [], s.controls[id]);
      const req = api.requestRaw<{ results: CompareEntry[] }>(
        "tts.compare_engines",
        { project_id: projectId, engine_ids: engineIds, segment_index: segmentIndex, settings, ...(referenceId ? { reference_id: referenceId } : {}), ...(s.seed != null ? { seed: s.seed } : {}) },
        { onProgress: onJobProgress },
      );
      startJob("compare", "Compare engines", req.id, null);
      try {
        const r = await req;
        if (get().projectId !== projectId) return false;
        set({ compare: { segmentIndex, engineIds, results: r.results }, job: null, notice: `Compared ${r.results.filter((x) => !x.error).length} of ${engineIds.length} engines on segment ${segmentIndex + 1}.` });
        void refreshProject();
        return true;
      } catch (err) {
        const we = WorkerError.from(err);
        const partial = Array.isArray(we.details.results) ? (we.details.results as CompareEntry[]) : [];
        set({ compare: partial.length ? { segmentIndex, engineIds, results: partial } : get().compare, job: null, error: toError(we, "compare") });
        void refreshProject();
        return false;
      }
    },

    async selectTake(segmentIndex, takeId) {
      const projectId = get().projectId;
      if (!projectId) return;
      try {
        await api.projects.selectTake({ id: projectId, segment_index: segmentIndex, take_id: takeId });
        set((st) => ({ segments: st.segments.map((seg) => (seg.index === segmentIndex ? { ...seg, selected_take_id: takeId, status: statusFromTakes(seg.takes, takeId) } : seg)) }));
      } catch (err) {
        set({ error: toError(err, "project") });
      }
    },

    async retry() {
      const e = get().error;
      if (!e) return;
      set({ error: null });
      if (e.retry) await get().generate(e.retry);
      else if (e.context === "plan") await get().runPlan();
      else if (e.context === "assemble") await get().assemble();
      else if (e.context === "save") await get().saveScriptNow();
    },

    dismissError: () => set({ error: null }),

    // ---------------------------------------------------------------------- ui
    openDrawer: (segmentIndex) => set({ drawerSegment: segmentIndex }),
    playTake: (path, label) => set((s) => ({ previewTake: { path, label, nonce: (s.previewTake?.nonce ?? 0) + 1 } })),
    stopTakePreview: () => set({ previewTake: null }),
  };
});

/** Test/reset hook: clears pending timers and returns the store to its initial shape. */
export function __resetCreateStore(): void {
  if (settingsTimer != null) window.clearTimeout(settingsTimer);
  settingsTimer = null;
  const initial = useCreateStore.getInitialState();
  useCreateStore.setState({ ...initial, plan: defaultPlanOptions() }, true);
}
