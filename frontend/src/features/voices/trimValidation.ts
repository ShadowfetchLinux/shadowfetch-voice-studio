/**
 * Selection (trim) helpers validated against the engine's declared `Capabilities.reference` limits.
 * Pure functions — unit-tested in src/__tests__/voices.trim.test.tsx.
 */
import type { ReferenceRequirements } from "@/lib/protocol";
import type { Selection } from "@/components/audio/waveformMath";
import { clamp } from "@/lib/format";

/** Default target when the engine declares no recommendation (task spec: 10–15 s). */
export const DEFAULT_SUGGESTED_RANGE: [number, number] = [10, 15];

export type TrimLevel = "ok" | "warn" | "error";

export interface TrimVerdict {
  level: TrimLevel;
  message: string;
  duration_s: number;
}

/**
 * Suggest an initial selection: as long as the recommended range allows (upper bound of the recommendation,
 * capped at the engine maximum and the clip length), starting after any measured leading silence.
 */
export function suggestSelection(duration: number, ref: ReferenceRequirements | null | undefined, leadingSilence_s = 0): Selection | null {
  if (!(duration > 0)) return null;
  const [recLo, recHi] = ref?.recommended_seconds ?? DEFAULT_SUGGESTED_RANGE;
  const max = ref?.max_seconds ?? Infinity;
  const target = Math.min(recHi, max);
  const start = clamp(Number.isFinite(leadingSilence_s) ? Math.max(0, leadingSilence_s - 0.1) : 0, 0, Math.max(0, duration - Math.min(target, duration)));
  const end = Math.min(duration, start + target);
  // never suggest something shorter than the clip allows when the clip itself is shorter than the low bound
  if (end - start < Math.min(recLo, duration)) return { start: 0, end: duration };
  return { start, end };
}

/** Validate a selection against the engine limits. `null` requirements → only sanity checks (no engine to judge). */
export function validateSelection(sel: Selection | null, ref: ReferenceRequirements | null | undefined): TrimVerdict {
  if (!sel) return { level: "error", message: "Select the part of the recording to use as the reference.", duration_s: 0 };
  const d = Math.max(0, sel.end - sel.start);
  if (d < 0.5) return { level: "error", message: "The selection is shorter than half a second.", duration_s: d };
  if (!ref) return { level: "warn", message: "No engine limits available — the selection cannot be checked against an engine yet.", duration_s: d };
  if (d < ref.min_seconds) return { level: "error", message: `Too short: the engine needs at least ${fmt(ref.min_seconds)} s (selected ${d.toFixed(1)} s).`, duration_s: d };
  if (d > ref.max_seconds) return { level: "error", message: `Too long: the engine accepts at most ${fmt(ref.max_seconds)} s (selected ${d.toFixed(1)} s).`, duration_s: d };
  const [lo, hi] = ref.recommended_seconds;
  if (d < lo || d > hi) return { level: "warn", message: `Allowed, but outside the recommended ${fmt(lo)}–${fmt(hi)} s (selected ${d.toFixed(1)} s).`, duration_s: d };
  return { level: "ok", message: `${d.toFixed(1)} s — within the recommended ${fmt(lo)}–${fmt(hi)} s.`, duration_s: d };
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
