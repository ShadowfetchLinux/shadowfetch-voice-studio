import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  api: {
    request: vi.fn(),
    requestRaw: vi.fn(),
    cancel: vi.fn(async () => {}),
    events: { on: () => () => {}, onWorkerStatus: () => () => {}, onRuntimeLog: () => () => {} },
    projects: { list: vi.fn(), get: vi.fn(async () => { throw { code: "NOT_FOUND", message: "no refresh in this test" }; }), create: vi.fn(), update: vi.fn(async () => ({})), saveScript: vi.fn(), selectTake: vi.fn() },
    voices: { list: vi.fn() },
    tts: { plan: vi.fn(), assemble: vi.fn(), compareEngines: vi.fn() },
    audio: { peaks: vi.fn() },
    shell: { pickTextFile: vi.fn(), readTextFile: vi.fn(), fileSrc: (p: string) => p },
  },
  isPreviewMock: () => false,
  isTauri: () => false,
}));

import { api, type RequestOptions, type RequestPromise } from "@/lib/api";
import type { Progress, WorkerErrorShape } from "@/lib/protocol";
import { useAppStore } from "@/store/appStore";
import { ProgressPanel } from "@/features/create/components/ProgressPanel";
import { __resetCreateStore, useCreateStore } from "@/features/create/createStore";
import { makeCaps, makeEngine, makeVoice, plannedViews } from "@/features/create/testing/fixtures";

/** A controllable stand-in for `api.requestRaw`: exposes the progress callback and a reject/resolve handle. */
function controllableRequest() {
  let onProgress: ((p: Progress) => void) | undefined;
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  }) as RequestPromise<unknown>;
  Object.defineProperty(promise, "id", { value: "req-1" });
  Object.defineProperty(promise, "cancel", { value: () => api.cancel("req-1") });
  vi.mocked(api.requestRaw).mockImplementation((_m: string, _p: unknown, opts?: RequestOptions) => {
    onProgress = opts?.onProgress;
    return promise as RequestPromise<never>;
  });
  return { progress: (p: Omit<Progress, "id">) => onProgress?.({ id: "req-1", ...p }), resolve, reject };
}

function seed() {
  const caps = makeCaps({ controls: [{ id: "temperature", label: "T", type: "float", min: 0, max: 2, step: 0.1, default: 0.9 }] });
  useAppStore.setState({ engines: [makeEngine(caps)], engineStates: {}, settings: null });
  useCreateStore.setState({ projectId: "proj_test1", engineId: caps.id, language: "en", voiceId: "voice_1", referenceId: "ref_1", voices: [makeVoice()], segments: plannedViews(), controls: { [caps.id]: { temperature: 1.1, stale_control: 5 } }, seed: 7 });
}

const COMPLETED_TAKE = { segment_index: 0, take_id: "take_new", path: "/data/projects/proj_test1/segments/seg_a/take_new.wav", duration_s: 1.8, seed: 7 };

describe("cancel keeps completed segments", () => {
  beforeEach(() => {
    __resetCreateStore();
    vi.clearAllMocks();
  });

  it("sends only declared controls, tracks measured progress, and merges completed takes on CANCELLED", async () => {
    seed();
    const ctl = controllableRequest();
    const done = useCreateStore.getState().generate({ mode: "full" });

    await vi.waitFor(() => expect(useCreateStore.getState().job?.requestId).toBe("req-1"));
    const [method, params] = vi.mocked(api.requestRaw).mock.calls[0]!;
    expect(method).toBe("tts.generate");
    expect(params).toEqual({ project_id: "proj_test1", engine_id: "test-engine", reference_id: "ref_1", language: "en", settings: { temperature: 1.1 }, seed: 7 });
    expect(useCreateStore.getState().segments.map((s) => s.status)).toEqual(["queued", "queued", "queued"]);

    ctl.progress({ stage: "generate", message: "Generating segment 1 of 3", current: 1, total: 3, detail: { segment_index: 0 } });
    let st = useCreateStore.getState();
    expect(st.job).toMatchObject({ message: "Generating segment 1 of 3", current: 1, total: 3, segmentIndex: 0 });
    expect(st.segments[0]!.status).toBe("generating");

    await st.cancelJob();
    expect(api.cancel).toHaveBeenCalledWith("req-1");
    expect(useCreateStore.getState().job?.cancelling).toBe(true);

    ctl.reject({ code: "CANCELLED", message: "cancelled", details: { completed: [COMPLETED_TAKE], failed_segment: 1 }, recoverable: true } satisfies WorkerErrorShape);
    expect(await done).toBe(false);

    st = useCreateStore.getState();
    expect(st.job).toBeNull();
    expect(st.error).toMatchObject({ code: "CANCELLED", completed: 1, context: "generate" });
    // segment 0 finished before the cancel → its take is kept and selected
    expect(st.segments[0]!.status).toBe("ok");
    expect(st.segments[0]!.selected_take_id).toBe("take_new");
    expect(st.segments[0]!.takes.map((t) => t.id)).toEqual(["take_new"]);
    // the segment that was interrupted is not marked failed, the rest go back to "no take"
    expect(st.segments[1]!.status).toBe("none");
    expect(st.segments[1]!.error).toBeNull();
    expect(st.segments[2]!.status).toBe("none");
  });

  it("marks the failed segment and keeps completed ones on ENGINE_CRASHED, with a retry of the same scope", async () => {
    seed();
    const ctl = controllableRequest();
    const done = useCreateStore.getState().generate({ mode: "indices", indices: [0, 2] });
    await vi.waitFor(() => expect(useCreateStore.getState().job).not.toBeNull());
    expect(vi.mocked(api.requestRaw).mock.calls[0]![1]).toMatchObject({ segment_indices: [0, 2] });
    expect(useCreateStore.getState().segments.map((s) => s.status)).toEqual(["queued", "none", "queued"]);

    ctl.reject({ code: "ENGINE_CRASHED", message: "engine host exited", details: { completed: [COMPLETED_TAKE], failed_segment: 2 }, recoverable: true });
    expect(await done).toBe(false);
    const st = useCreateStore.getState();
    expect(st.segments[0]!.status).toBe("ok");
    expect(st.segments[2]!.status).toBe("failed");
    expect(st.segments[2]!.error).toBe("engine host exited");
    expect(st.error).toMatchObject({ code: "ENGINE_CRASHED", retry: { mode: "indices", indices: [0, 2] }, completed: 1 });

    render(<ProgressPanel />);
    expect(screen.getByRole("alert")).toHaveTextContent("ENGINE_CRASHED");
    expect(screen.getByRole("alert")).toHaveTextContent("1 completed segment was kept");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("refuses to generate without a voice reference and explains why", async () => {
    seed();
    useCreateStore.setState({ voiceId: null, referenceId: null, voices: [] });
    expect(await useCreateStore.getState().generate({ mode: "full" })).toBe(false);
    expect(api.requestRaw).not.toHaveBeenCalled();
    expect(useCreateStore.getState().error?.message).toMatch(/no voice reference/);
  });
});
