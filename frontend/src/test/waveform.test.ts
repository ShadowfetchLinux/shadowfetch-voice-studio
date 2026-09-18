import { describe, expect, it } from "vitest";
import {
  clampSelection,
  clampZoom,
  columnPeaks,
  contentWidth,
  maxScroll,
  nudgeSelection,
  tickLabel,
  tickStep,
  timeToX,
  xToTime,
  zoomAround,
  type View,
} from "@/components/audio/waveformMath";

const view: View = { width: 800, zoom: 4, scrollX: 1000, duration: 20 };

describe("waveform geometry", () => {
  it("maps time ↔ x consistently under zoom and scroll", () => {
    expect(contentWidth(view)).toBe(3200);
    expect(maxScroll(view)).toBe(2400);
    // 10 s is the middle of the content (1600 px) minus the scroll offset
    expect(timeToX(10, view)).toBe(600);
    expect(xToTime(600, view)).toBeCloseTo(10, 9);
    for (const t of [0, 3.3, 7.77, 19.99, 20]) expect(xToTime(timeToX(t, view), view)).toBeCloseTo(t, 9);
    // out of range is clamped
    expect(xToTime(-5000, view)).toBe(0);
    expect(xToTime(5000, view)).toBe(20);
    expect(timeToX(0, { ...view, zoom: 1, scrollX: 0 })).toBe(0);
    expect(timeToX(20, { ...view, zoom: 1, scrollX: 0 })).toBe(800);
  });

  it("clamps zoom to 1–16 and keeps the anchored time fixed when zooming", () => {
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(40)).toBe(16);
    const anchorX = 300;
    const before = xToTime(anchorX, view);
    const next = zoomAround(view, 2, anchorX);
    expect(next.zoom).toBe(8);
    const after = xToTime(anchorX, { ...view, zoom: next.zoom, scrollX: next.scrollX });
    expect(after).toBeCloseTo(before, 6);
    // scroll never exceeds the range
    const out = zoomAround({ ...view, zoom: 16, scrollX: 12000 }, 0.5, 0);
    expect(out.scrollX).toBeLessThanOrEqual(maxScroll({ width: 800, zoom: 8 }));
    expect(out.scrollX).toBeGreaterThanOrEqual(0);
  });
});

describe("selection math", () => {
  it("orders and clamps a dragged selection and enforces a minimum length", () => {
    expect(clampSelection({ start: 5, end: 2 }, 20)).toEqual({ start: 2, end: 5 });
    expect(clampSelection({ start: -3, end: 25 }, 20)).toEqual({ start: 0, end: 20 });
    expect(clampSelection({ start: 4, end: 4 }, 20, 0.05)).toEqual({ start: 4, end: 4.05 });
    // at the very end the minimum length pushes the start back instead
    expect(clampSelection({ start: 20, end: 20 }, 20, 0.05)).toEqual({ start: 19.95, end: 20 });
  });

  it("nudges handles by 0.05 s (0.5 s with shift) without crossing each other", () => {
    const sel = { start: 2, end: 4 };
    expect(nudgeSelection(sel, "start", 1, false, 20)).toEqual({ start: 2.05, end: 4 });
    expect(nudgeSelection(sel, "start", -1, true, 20)).toEqual({ start: 1.5, end: 4 });
    expect(nudgeSelection(sel, "end", 1, true, 20)).toEqual({ start: 2, end: 4.5 });
    expect(nudgeSelection(sel, "end", -1, false, 20).end).toBeCloseTo(3.95, 9);
    // cannot cross
    const tight = { start: 3.97, end: 4 };
    expect(nudgeSelection(tight, "start", 1, true, 20)).toEqual({ start: 3.95, end: 4 });
    const pushed = nudgeSelection(tight, "end", -1, true, 20);
    expect(pushed.start).toBe(3.97);
    expect(pushed.end).toBeCloseTo(4.02, 9);
    // cannot leave the file
    expect(nudgeSelection({ start: 0.02, end: 1 }, "start", -1, false, 20).start).toBe(0);
    expect(nudgeSelection({ start: 19, end: 19.98 }, "end", 1, true, 20).end).toBe(20);
  });
});

describe("peak aggregation and ruler", () => {
  it("aggregates source peaks into per-column min/max over a fractional range", () => {
    const peaks: Array<[number, number]> = [];
    for (let i = 0; i < 100; i++) peaks.push([-(i / 100), i / 100]);
    const cols = columnPeaks(peaks, 10);
    expect(cols).toHaveLength(10);
    expect(cols[0]).toEqual([-0.09, 0.09]);
    expect(cols[9]).toEqual([-0.99, 0.99]);
    // second half only
    const half = columnPeaks(peaks, 5, 0.5, 1);
    expect(half[0]![1]).toBeCloseTo(0.59, 9);
    expect(half[4]![1]).toBeCloseTo(0.99, 9);
    expect(columnPeaks([], 5)).toEqual([]);
  });

  it("chooses ruler ticks that stay apart and formats labels", () => {
    expect(tickStep(10)).toBe(10); // 10 px/s → 10 s ticks ≥ 72 px
    expect(tickStep(200)).toBe(0.5);
    expect(tickStep(2000)).toBe(0.05);
    expect(tickLabel(65, 5)).toBe("1:05");
    expect(tickLabel(1.5, 0.5)).toBe("0:01.5");
    expect(tickLabel(0.25, 0.05)).toBe("0:00.25");
  });
});
