import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api", () => ({
  api: {
    request: vi.fn(),
    requestRaw: vi.fn(),
    cancel: vi.fn(async () => {}),
    events: { on: () => () => {}, onWorkerStatus: () => () => {}, onRuntimeLog: () => () => {} },
    projects: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), saveScript: vi.fn(), selectTake: vi.fn(async () => ({ ok: true })) },
    voices: { list: vi.fn() },
    tts: { plan: vi.fn(), assemble: vi.fn(), compareEngines: vi.fn() },
    audio: { peaks: vi.fn() },
    shell: { pickTextFile: vi.fn(), readTextFile: vi.fn(), fileSrc: (p: string) => p, mediaSrc: async (p: string) => p, releaseMediaSrc: () => undefined },
  },
  isPreviewMock: () => false,
  isTauri: () => false,
}));

import { api } from "@/lib/api";
import { SegmentList } from "@/features/create/components/SegmentList";
import { __resetCreateStore, useCreateStore } from "@/features/create/createStore";
import { makeTake, plannedViews } from "@/features/create/testing/fixtures";
import { statusFromTakes } from "@/features/create/planMath";

function seed() {
  const segments = plannedViews();
  const take = makeTake();
  segments[0] = { ...segments[0]!, takes: [take], selected_take_id: take.id, status: statusFromTakes([take], take.id) };
  segments[2] = { ...segments[2]!, status: "failed", error: "GPU ran out of memory (synthetic)" };
  useCreateStore.setState({ projectId: "proj_test1", segments, planWarnings: ["Segment size 400 exceeds the engine limit of 300 characters; using 300."] });
  return segments;
}

describe("segment list from a plan", () => {
  beforeEach(() => {
    __resetCreateStore();
    vi.clearAllMocks();
  });

  it("renders index, paragraph, original text and only shows normalized text when it differs", () => {
    seed();
    render(<SegmentList selectedIndexes={[]} />);
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(3);
    expect(screen.getByText("3 segments")).toBeInTheDocument();
    expect(screen.getByText(/exceeds the engine limit/)).toBeInTheDocument();

    const first = within(cards[0]!);
    expect(first.getByText("#1")).toBeInTheDocument();
    expect(first.getByText("Paragraph 1")).toBeInTheDocument();
    expect(first.getByText("Hello there, Dr. Smith.")).toBeInTheDocument();
    expect(first.getByText("Engine receives")).toBeInTheDocument();
    expect(first.getByText("Hello there, Dr. Smyth.")).toBeInTheDocument();
    const subs = first.getByRole("list", { name: "Substitutions" });
    expect(subs).toHaveTextContent("Smith");
    expect(subs).toHaveTextContent("Smyth");

    const second = within(cards[1]!);
    expect(second.queryByText("Engine receives")).not.toBeInTheDocument();
    expect(second.getByText("Paragraph 1")).toBeInTheDocument();
    const third = within(cards[2]!);
    expect(third.getByText("Paragraph 2")).toBeInTheDocument();
  });

  it("shows per-segment status, the takes dropdown with label/duration/seed and errors", () => {
    seed();
    render(<SegmentList selectedIndexes={[]} />);
    const cards = screen.getAllByRole("article");
    const first = within(cards[0]!);
    expect(first.getByText("Take ready")).toBeInTheDocument();
    const takes = first.getByRole("combobox", { name: "Takes for segment 1" });
    expect(takes).toHaveValue("take_1");
    expect(within(takes).getByRole("option", { name: "Take 1 · 2.4 s · seed 42" })).toBeInTheDocument();
    expect(first.getByRole("button", { name: "Play take of segment 1" })).toBeEnabled();

    const second = within(cards[1]!);
    expect(second.getByText("No take")).toBeInTheDocument();
    expect(second.getByText("No takes yet")).toBeInTheDocument();
    expect(second.getByRole("button", { name: "Play take of segment 2" })).toBeDisabled();

    const third = within(cards[2]!);
    expect(third.getByText("Failed")).toBeInTheDocument();
    expect(third.getByRole("alert")).toHaveTextContent("GPU ran out of memory (synthetic)");
  });

  it("'Regenerate this segment' scopes the request to that segment and states the scope", async () => {
    seed();
    const generate = vi.fn(async () => true);
    useCreateStore.setState({ generate });
    const user = userEvent.setup();
    render(<SegmentList selectedIndexes={[1]} />);
    const cards = screen.getAllByRole("article");
    expect(cards[1]).toHaveClass("border-accent");
    expect(cards[0]).not.toHaveClass("border-accent");
    await user.click(within(cards[1]!).getByRole("button", { name: "Regenerate this segment" }));
    expect(generate).toHaveBeenCalledWith({ mode: "indices", indices: [1] });
    expect(within(cards[1]!).getByText(/Scope: whole segment/)).toBeInTheDocument();
  });

  it("choosing a take calls projects.select_take and updates the selection", async () => {
    const segments = seed();
    const takeB = makeTake({ id: "take_2", seed: 7, duration_s: 2.9, created_at: "2026-01-01T00:00:02Z" });
    segments[0] = { ...segments[0]!, takes: [...segments[0]!.takes, takeB] };
    useCreateStore.setState({ segments });
    const user = userEvent.setup();
    render(<SegmentList selectedIndexes={[]} />);
    const takes = screen.getByRole("combobox", { name: "Takes for segment 1" });
    await user.selectOptions(takes, "take_2");
    expect(api.projects.selectTake).toHaveBeenCalledWith({ id: "proj_test1", segment_index: 0, take_id: "take_2" });
    await vi.waitFor(() => expect(useCreateStore.getState().segments[0]!.selected_take_id).toBe("take_2"));
    expect(screen.getByRole("button", { name: "Compare takes of segment 1" })).toBeInTheDocument();
  });

  it("disables regeneration while a job runs and shows an empty state before planning", () => {
    seed();
    useCreateStore.setState({ job: { kind: "generate", requestId: "r1", label: "Generate full", stage: "generate", message: "Generating segment 1 of 3", current: 1, total: 3, segmentIndex: 0, startedAt: 0, cancelling: false, request: { mode: "full" } } });
    const { unmount } = render(<SegmentList selectedIndexes={[]} />);
    for (const b of screen.getAllByRole("button", { name: "Regenerate this segment" })) expect(b).toBeDisabled();
    unmount();
    useCreateStore.setState({ segments: [], job: null });
    render(<SegmentList selectedIndexes={[]} />);
    expect(screen.getByText("Not planned yet")).toBeInTheDocument();
  });
});
