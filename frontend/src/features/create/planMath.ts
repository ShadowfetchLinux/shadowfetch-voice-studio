/**
 * Pure helpers for the Create page: counting, selection→segment mapping, token insertion, duration
 * estimates and normalisation of worker result shapes. No React, no API calls — unit-tested directly.
 */
import type { Capabilities, ControlSpec, Project, Segment, Take } from "@/lib/protocol";
import { clamp } from "@/lib/format";
import type { PlanOptionsState, SegmentStatus, SegmentView, TextRange } from "./types";

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/** Number of whitespace-separated words. */
export function wordCount(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

// ---------------------------------------------------------------------------
// Selection → segments
// ---------------------------------------------------------------------------

/**
 * Locate every planned segment inside the script. A segment's `text` is the script text verbatim except
 * that whitespace runs collapse to one space (see backend text/segmenter.py), so matching ignores whitespace
 * on both sides and walks forward so repeated sentences map to the right occurrence. Unfound → null.
 */
export function locateSegments(script: string, segments: ReadonlyArray<{ text: string }>): Array<TextRange | null> {
  const positions: number[] = [];
  const chars: string[] = [];
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    if (!/\s/.test(ch)) {
      chars.push(ch);
      positions.push(i);
    }
  }
  const stream = chars.join("");
  let cursor = 0;
  return segments.map((seg) => {
    const needle = seg.text.replace(/\s+/g, "");
    if (!needle) return null;
    const at = stream.indexOf(needle, cursor);
    if (at < 0) return null;
    cursor = at + needle.length;
    return { start: positions[at]!, end: positions[cursor - 1]! + 1 };
  });
}

/** Indexes of the segments whose text overlaps a non-empty editor selection (in plan order). */
export function segmentsInSelection(script: string, sel: TextRange | null, segments: ReadonlyArray<{ index: number; text: string }>): number[] {
  if (!sel || sel.end <= sel.start) return [];
  const ranges = locateSegments(script, segments);
  const out: number[] = [];
  segments.forEach((s, i) => {
    const r = ranges[i];
    if (r && sel.start < r.end && sel.end > r.start) out.push(s.index);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Editor helpers
// ---------------------------------------------------------------------------

/** Insert a tag token at the cursor (replacing any selection), padded with spaces so it stays its own word. */
export function insertToken(text: string, token: string, sel: TextRange): { text: string; cursor: number } {
  const start = clamp(Math.min(sel.start, sel.end), 0, text.length);
  const end = clamp(Math.max(sel.start, sel.end), 0, text.length);
  const before = text.slice(0, start);
  const after = text.slice(end);
  const pre = before && !/\s$/.test(before) ? " " : "";
  const post = after && !/^\s/.test(after) ? " " : "";
  const inserted = pre + token + post;
  return { text: before + inserted + after, cursor: before.length + inserted.length };
}

// ---------------------------------------------------------------------------
// Duration estimate
// ---------------------------------------------------------------------------

/** Assumed reading speed for segments without a take: ≈150 words/min at ~6 characters per word. */
export const EST_CHARS_PER_SECOND = 15;

export interface DurationEstimate {
  seconds: number;
  /** Segments whose selected take has a measured duration. */
  measured: number;
  /** Segments estimated from character count. */
  estimated: number;
}

/** Approximate spoken length: measured take durations where available, otherwise a character-rate estimate, plus pauses. */
export function estimateDuration(segments: readonly SegmentView[], plan: Pick<PlanOptionsState, "sentence_pause_ms" | "paragraph_pause_ms">): DurationEstimate {
  let seconds = 0;
  let measured = 0;
  let estimated = 0;
  segments.forEach((s, i) => {
    const take = selectedTake(s);
    if (take?.duration_s != null && Number.isFinite(take.duration_s)) {
      seconds += take.duration_s;
      measured++;
    } else {
      seconds += s.char_count / EST_CHARS_PER_SECOND;
      estimated++;
    }
    if (i > 0) {
      const prev = segments[i - 1]!;
      seconds += (prev.paragraph !== s.paragraph ? plan.paragraph_pause_ms : plan.sentence_pause_ms) / 1000;
    }
  });
  return { seconds, measured, estimated };
}

// ---------------------------------------------------------------------------
// Takes / segments
// ---------------------------------------------------------------------------

export function selectedTake(seg: SegmentView): Take | null {
  if (!seg.selected_take_id) return null;
  return seg.takes.find((t) => t.id === seg.selected_take_id) ?? null;
}

/**
 * Status derived purely from persisted takes (used to reset segments after a job). Only a selected `ok`
 * take counts as ready — that is exactly what `tts.generate` (skip) and `tts.assemble` (use) look at.
 */
export function statusFromTakes(takes: readonly Take[], selected: string | null): SegmentStatus {
  const sel = selected ? takes.find((t) => t.id === selected) : undefined;
  if (sel?.status === "ok") return "ok";
  if (!sel && takes.length > 0 && takes.every((t) => t.status === "failed")) return "failed";
  return "none";
}

/** Human label for a take in dropdowns: "Take 2 · 3.4 s · seed 123". */
export function takeLabel(take: Take, position: number): string {
  const name = take.label && !take.label.startsWith("compare:") ? take.label : `Take ${position + 1}`;
  const dur = take.duration_s != null ? `${take.duration_s.toFixed(1)} s` : "duration unknown";
  const seed = take.seed != null ? `seed ${take.seed}` : "no seed";
  return `${name} · ${dur} · ${seed}`;
}

/** Whether every segment has a usable selected take (assemble precondition). */
export function allSegmentsHaveTakes(segments: readonly SegmentView[]): boolean {
  return segments.length > 0 && segments.every((s) => selectedTake(s)?.status === "ok");
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Values for exactly the controls an engine declared: stored value if present, else the declared default. */
export function controlValues(specs: readonly ControlSpec[], stored: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of specs) out[c.id] = stored && c.id in stored ? stored[c.id] : c.default;
  return out;
}

/** Max chars per segment clamped to the engine limit (when known). */
export function clampMaxChars(value: number, caps: Capabilities | null | undefined): number {
  const v = Math.max(20, Math.round(value));
  return caps?.max_chars_per_request ? Math.min(v, caps.max_chars_per_request) : v;
}

/** Pick a language the engine supports: preferred → fallback → first declared → preferred as-is. */
export function pickLanguage(caps: Capabilities | null | undefined, preferred: string | null | undefined, fallback: string): string {
  const codes = caps?.languages.map((l) => l.code) ?? [];
  if (codes.length === 0) return preferred || fallback;
  if (preferred && codes.includes(preferred)) return preferred;
  if (codes.includes(fallback)) return fallback;
  return codes[0]!;
}

// ---------------------------------------------------------------------------
// Result-shape normalisation
// ---------------------------------------------------------------------------

type RawSegment = Partial<Segment> & { index?: number; idx?: number; char_count?: number; takes?: Take[]; take_count?: number; selected_take_id?: string | null };

/** Build a `SegmentView` from a `tts.plan` segment or a `projects.get` segment (index vs idx, takes optional). */
export function toSegmentView(raw: RawSegment, takesOverride?: Take[]): SegmentView {
  const takes = [...(takesOverride ?? raw.takes ?? [])].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id));
  // An explicit null means "deselected" (projects.select_take allows it); only an absent field defaults to the newest take.
  const selected = raw.selected_take_id !== undefined ? raw.selected_take_id : takes.length ? takes[takes.length - 1]!.id : null;
  const text = raw.text ?? "";
  const normalized = raw.normalized_text ?? text;
  return {
    id: raw.id ?? null,
    index: raw.index ?? raw.idx ?? 0,
    paragraph: raw.paragraph ?? 0,
    text,
    normalized_text: normalized,
    substitutions: (raw.substitutions ?? []) as SegmentView["substitutions"],
    char_count: raw.char_count ?? normalized.length,
    takes,
    selected_take_id: selected,
    status: statusFromTakes(takes, selected),
    error: null,
  };
}

export interface ProjectViewData {
  project: Project;
  scriptText: string;
  scriptVersion: number | null;
  segments: SegmentView[];
}

/**
 * `projects.get` returns `{project, script, segments, exports}` (backend jobs/projects.py); the protocol
 * mirror types it flat. Accept both.
 */
export function normalizeProjectDetail(raw: unknown): ProjectViewData {
  const r = (raw ?? {}) as Record<string, unknown>;
  const project = ((r.project as Project | undefined) ?? (r as unknown as Project)) as Project;
  const script = r.script as { text?: string; version?: number } | null | undefined;
  const scriptText = typeof r.script_text === "string" ? r.script_text : (script?.text ?? "");
  const scriptVersion = typeof r.script_version === "number" ? r.script_version : (script?.version ?? null);
  const segs = Array.isArray(r.segments) ? (r.segments as RawSegment[]) : [];
  const segments = segs.map((s) => toSegmentView(s)).sort((a, b) => a.index - b.index);
  return { project: { ...project, settings: project.settings ?? {} }, scriptText, scriptVersion, segments };
}

/** Read plan options stored on a project, falling back to app defaults. */
export function planOptionsFrom(project: Project | null, defaults: PlanOptionsState): PlanOptionsState {
  const stored = (project?.settings?.plan ?? {}) as Partial<PlanOptionsState>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    max_chars: num(stored.max_chars, defaults.max_chars),
    paragraph_pause_ms: num(stored.paragraph_pause_ms, defaults.paragraph_pause_ms),
    sentence_pause_ms: num(stored.sentence_pause_ms, defaults.sentence_pause_ms),
    pronunciation: Array.isArray(stored.pronunciation)
      ? stored.pronunciation.filter((p): p is { from: string; to: string } => !!p && typeof p.from === "string").map((p) => ({ from: p.from, to: String(p.to ?? "") }))
      : defaults.pronunciation,
    spell_numbers: typeof stored.spell_numbers === "boolean" ? stored.spell_numbers : defaults.spell_numbers,
  };
}
