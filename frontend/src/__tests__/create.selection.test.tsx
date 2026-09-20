import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api", () => ({
  api: {
    request: vi.fn(),
    requestRaw: vi.fn(),
    cancel: vi.fn(async () => {}),
    events: { on: () => () => {}, onWorkerStatus: () => () => {}, onRuntimeLog: () => () => {} },
    projects: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), saveScript: vi.fn(), selectTake: vi.fn() },
    voices: { list: vi.fn() },
    tts: { plan: vi.fn(), assemble: vi.fn(), compareEngines: vi.fn() },
    audio: { peaks: vi.fn() },
    shell: { pickTextFile: vi.fn(), readTextFile: vi.fn(), fileSrc: (p: string) => p, mediaSrc: async (p: string) => p, releaseMediaSrc: () => undefined },
  },
  isPreviewMock: () => false,
  isTauri: () => false,
}));

import { ActionsRow } from "@/features/create/components/ActionsRow";
import { __resetCreateStore, useCreateStore } from "@/features/create/createStore";
import { estimateDuration, insertToken, locateSegments, segmentsInSelection, wordCount } from "@/features/create/planMath";
import { PLANNED, SCRIPT, makeTake, plannedViews } from "@/features/create/testing/fixtures";

describe("editor selection → segment mapping", () => {
  it("locates each segment in the script even when the script's whitespace differs", () => {
    const script = "Hello there,\nDr. Smith.   This is the first paragraph with 3 sentences.\n\n\nSecond paragraph starts here. It ends now.";
    const ranges = locateSegments(script, PLANNED);
    expect(ranges).toHaveLength(3);
    expect(script.slice(ranges[0]!.start, ranges[0]!.end)).toBe("Hello there,\nDr. Smith.");
    expect(script.slice(ranges[1]!.start, ranges[1]!.end)).toBe("This is the first paragraph with 3 sentences.");
    expect(script.slice(ranges[2]!.start, ranges[2]!.end)).toBe("Second paragraph starts here. It ends now.");
  });

  it("returns null for a segment that no longer exists in the (edited) script and keeps walking forward", () => {
    const script = "Hello there, Dr. Smith. Second paragraph starts here. It ends now.";
    const ranges = locateSegments(script, PLANNED);
    expect(ranges[0]).not.toBeNull();
    expect(ranges[1]).toBeNull();
    expect(ranges[2]).not.toBeNull();
  });

  it("maps repeated sentences to their own occurrence", () => {
    const script = "Same line. Same line.";
    const segs = [
      { index: 0, text: "Same line." },
      { index: 1, text: "Same line." },
    ];
    const ranges = locateSegments(script, segs);
    expect(ranges[0]).toEqual({ start: 0, end: 10 });
    expect(ranges[1]).toEqual({ start: 11, end: 21 });
  });

  it("selects the segments overlapping a highlighted range and nothing for a caret", () => {
    const secondStart = SCRIPT.indexOf("This is the first");
    // selection from inside segment 0 into the start of segment 1
    expect(segmentsInSelection(SCRIPT, { start: 5, end: secondStart + 4 }, PLANNED)).toEqual([0, 1]);
    // selection entirely inside the last paragraph
    const p2 = SCRIPT.indexOf("It ends now.");
    expect(segmentsInSelection(SCRIPT, { start: p2, end: p2 + 3 }, PLANNED)).toEqual([2]);
    // caret only → nothing
    expect(segmentsInSelection(SCRIPT, { start: 5, end: 5 }, PLANNED)).toEqual([]);
    expect(segmentsInSelection(SCRIPT, null, PLANNED)).toEqual([]);
    // whitespace-only selection between paragraphs → nothing
    const gap = SCRIPT.indexOf("\n\n");
    expect(segmentsInSelection(SCRIPT, { start: gap, end: gap + 2 }, PLANNED)).toEqual([]);
  });

  it("inserts tag tokens padded as their own word and counts words", () => {
    expect(insertToken("Hello world", "[laugh]", { start: 5, end: 5 })).toEqual({ text: "Hello [laugh] world", cursor: 13 });
    expect(insertToken("Hello world", "[laugh]", { start: 0, end: 0 })).toEqual({ text: "[laugh] Hello world", cursor: 8 });
    expect(insertToken("Hello world", "[sigh]", { start: 6, end: 11 })).toEqual({ text: "Hello [sigh]", cursor: 12 });
    expect(wordCount("  one two\nthree ")).toBe(3);
    expect(wordCount("")).toBe(0);
  });

  it("estimates duration from measured takes where present, otherwise from characters, plus pauses", () => {
    const segments = plannedViews();
    const take = makeTake({ duration_s: 2.0 });
    segments[0] = { ...segments[0]!, takes: [take], selected_take_id: take.id, status: "ok" };
    const est = estimateDuration(segments, { sentence_pause_ms: 250, paragraph_pause_ms: 600 });
    expect(est.measured).toBe(1);
    expect(est.estimated).toBe(2);
    // 2.0 s measured + (45 + 42) chars / 15 chars/s + one sentence pause + one paragraph pause
    expect(est.seconds).toBeCloseTo(2.0 + 87 / 15 + 0.25 + 0.6, 5);
  });
});

describe("Regenerate selection action", () => {
  beforeEach(() => {
    __resetCreateStore();
    vi.clearAllMocks();
  });

  it("is disabled without a selection and sends the mapped segment indexes when clicked", async () => {
    const generate = vi.fn(async () => true);
    useCreateStore.setState({ projectId: "proj_test1", engineId: "test-engine", script: SCRIPT, segments: plannedViews(), generate });
    const user = userEvent.setup();
    const { rerender } = render(<ActionsRow selectedIndexes={[]} onRequestCancel={() => {}} />);
    expect(screen.getByRole("button", { name: "Regenerate selection" })).toBeDisabled();
    expect(screen.getByText(/3 segments · approx\./)).toBeInTheDocument();

    rerender(<ActionsRow selectedIndexes={[0, 1]} onRequestCancel={() => {}} />);
    const btn = screen.getByRole("button", { name: "Regenerate selection (2)" });
    expect(btn).toBeEnabled();
    await user.click(btn);
    expect(generate).toHaveBeenCalledWith({ mode: "indices", indices: [0, 1] });

    await user.click(screen.getByRole("button", { name: "Preview first line" }));
    expect(generate).toHaveBeenLastCalledWith({ mode: "preview" });
    await user.click(screen.getByRole("button", { name: "Generate" }));
    expect(generate).toHaveBeenLastCalledWith({ mode: "full" });
  });
});
