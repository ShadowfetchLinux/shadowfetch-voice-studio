/**
 * Pure geometry/time helpers for the Waveform component (unit-tested without a DOM).
 * All x values are in CSS pixels; `scrollX` is the horizontal offset of the visible window
 * inside the zoomed content (contentWidth = width * zoom).
 */
import type { PeakPair } from "@/lib/protocol";
import { clamp } from "@/lib/format";

export interface Selection {
  start: number;
  end: number;
}

export interface View {
  /** Visible width in CSS px. */
  width: number;
  /** 1 … MAX_ZOOM */
  zoom: number;
  /** Scroll offset in content px. */
  scrollX: number;
  /** Total duration in seconds. */
  duration: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 16;
export const NUDGE_S = 0.05;
export const NUDGE_SHIFT_S = 0.5;
export const DEFAULT_MIN_SELECTION_S = 0.05;

export function clampZoom(z: number): number {
  return clamp(z, MIN_ZOOM, MAX_ZOOM);
}

export function contentWidth(view: Pick<View, "width" | "zoom">): number {
  return Math.max(1, view.width * clampZoom(view.zoom));
}

/** Largest valid scroll offset for the view. */
export function maxScroll(view: Pick<View, "width" | "zoom">): number {
  return Math.max(0, contentWidth(view) - view.width);
}

/** Seconds → x inside the *content* (before scrolling). */
export function timeToContentX(t: number, view: View): number {
  if (view.duration <= 0) return 0;
  return (clamp(t, 0, view.duration) / view.duration) * contentWidth(view);
}

/** Seconds → x inside the visible window. May be outside [0, width) when scrolled away. */
export function timeToX(t: number, view: View): number {
  return timeToContentX(t, view) - view.scrollX;
}

/** Visible-window x → seconds, clamped to the duration. */
export function xToTime(x: number, view: View): number {
  if (view.duration <= 0) return 0;
  const frac = (x + view.scrollX) / contentWidth(view);
  return clamp(frac * view.duration, 0, view.duration);
}

/** Normalise a selection: ordered, clamped to [0, duration], at least `minLen` long when possible. */
export function clampSelection(sel: Selection, duration: number, minLen = DEFAULT_MIN_SELECTION_S): Selection {
  let start = clamp(Math.min(sel.start, sel.end), 0, duration);
  let end = clamp(Math.max(sel.start, sel.end), 0, duration);
  if (end - start < minLen) {
    if (start + minLen <= duration) end = start + minLen;
    else {
      end = duration;
      start = Math.max(0, duration - minLen);
    }
  }
  return { start, end };
}

/**
 * Move one selection handle by a keyboard nudge (±0.05 s, ±0.5 s with shift).
 * The handle can never cross the other one (respecting `minLen`).
 */
export function nudgeSelection(sel: Selection, handle: "start" | "end", direction: 1 | -1, shift: boolean, duration: number, minLen = DEFAULT_MIN_SELECTION_S): Selection {
  const step = (shift ? NUDGE_SHIFT_S : NUDGE_S) * direction;
  if (handle === "start") {
    const start = clamp(sel.start + step, 0, Math.max(0, sel.end - minLen));
    return { start, end: sel.end };
  }
  const end = clamp(sel.end + step, Math.min(duration, sel.start + minLen), duration);
  return { start: sel.start, end };
}

/**
 * Change zoom by `factor` keeping the content under `anchorX` (visible px) stationary.
 * Returns the new zoom and a clamped scroll offset.
 */
export function zoomAround(view: View, factor: number, anchorX: number): { zoom: number; scrollX: number } {
  const zoom = clampZoom(view.zoom * factor);
  if (zoom === view.zoom) return { zoom, scrollX: clamp(view.scrollX, 0, maxScroll(view)) };
  const anchorFrac = (view.scrollX + anchorX) / contentWidth(view);
  const next = { ...view, zoom };
  const scrollX = clamp(anchorFrac * contentWidth(next) - anchorX, 0, maxScroll(next));
  return { zoom, scrollX };
}

/**
 * Aggregate source peaks into `columns` [min,max] pairs covering the fractional range [from, to) of the file.
 * Columns with no source data get the nearest sample so silence still draws a flat line.
 */
export function columnPeaks(peaks: readonly PeakPair[], columns: number, from = 0, to = 1): PeakPair[] {
  const out: PeakPair[] = [];
  const n = peaks.length;
  if (n === 0 || columns <= 0) return out;
  const span = Math.max(0, to - from);
  for (let c = 0; c < columns; c++) {
    const f0 = from + (span * c) / columns;
    const f1 = from + (span * (c + 1)) / columns;
    let i0 = Math.floor(f0 * n);
    let i1 = Math.ceil(f1 * n);
    i0 = clamp(i0, 0, n - 1);
    i1 = clamp(i1, i0 + 1, n);
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = i0; i < i1; i++) {
      const p = peaks[i];
      if (!p) continue;
      if (p[0] < mn) mn = p[0];
      if (p[1] > mx) mx = p[1];
    }
    if (!Number.isFinite(mn)) {
      mn = 0;
      mx = 0;
    }
    out.push([mn, mx]);
  }
  return out;
}

const TICK_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Ruler tick spacing (seconds) so labels stay at least `minPx` apart. */
export function tickStep(pxPerSecond: number, minPx = 72): number {
  for (const s of TICK_STEPS) if (s * pxPerSecond >= minPx) return s;
  return TICK_STEPS[TICK_STEPS.length - 1]!;
}

/** Ruler label: `m:ss` or `m:ss.t` for sub-second steps. */
export function tickLabel(t: number, step: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (step < 1) return `${m}:${s.toFixed(step < 0.25 ? 2 : 1).padStart(step < 0.25 ? 5 : 4, "0")}`;
  return `${m}:${Math.round(s).toString().padStart(2, "0")}`;
}
