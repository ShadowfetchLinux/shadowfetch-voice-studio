import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  api: {
    request: vi.fn(),
    requestRaw: vi.fn(),
    cancel: vi.fn(async () => {}),
    events: { on: () => () => {}, onWorkerStatus: () => () => {}, onRuntimeLog: () => () => {} },
    projects: { list: vi.fn(async () => ({ projects: [] })), get: vi.fn(), create: vi.fn(), update: vi.fn(), saveScript: vi.fn(), selectTake: vi.fn() },
    voices: { list: vi.fn(async () => ({ voices: [] })) },
    tts: { plan: vi.fn(), assemble: vi.fn(), compareEngines: vi.fn() },
    audio: { peaks: vi.fn() },
    shell: { pickTextFile: vi.fn(), readTextFile: vi.fn(), fileSrc: (p: string) => p },
  },
  isPreviewMock: () => false,
  isTauri: () => false,
}));

import { api } from "@/lib/api";
import { ProjectBar } from "@/features/create/components/ProjectBar";
import { AUTOSAVE_DEBOUNCE_MS, __resetCreateStore, useCreateStore } from "@/features/create/createStore";
import { useAutosave } from "@/features/create/useAutosave";
import { makeProject } from "@/features/create/testing/fixtures";

function Host() {
  useAutosave();
  return <ProjectBar />;
}

describe("script autosave", () => {
  beforeEach(() => {
    __resetCreateStore();
    vi.clearAllMocks();
    vi.useFakeTimers();
    const project = makeProject();
    useCreateStore.setState({ projectId: project.id, project, projects: [project], script: "Draft", savedScript: "Draft", saveState: "idle" });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces projects.save_script by 1.5 s and shows Saving… then Saved", async () => {
    let resolveSave!: (v: { script_version: number }) => void;
    vi.mocked(api.projects.saveScript).mockImplementation(() => new Promise((res) => (resolveSave = res)) as never);
    render(<Host />);
    expect(screen.getByText("Saved")).toBeInTheDocument();

    act(() => useCreateStore.getState().setScript("Draft v2"));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 200));
    expect(api.projects.saveScript).not.toHaveBeenCalled();

    // typing again resets the debounce window
    act(() => useCreateStore.getState().setScript("Draft v2 and more"));
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 200));
    expect(api.projects.saveScript).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(200));
    expect(api.projects.saveScript).toHaveBeenCalledTimes(1);
    expect(api.projects.saveScript).toHaveBeenCalledWith({ id: "proj_test1", text: "Draft v2 and more" });
    expect(screen.getByText("Saving…")).toBeInTheDocument();

    await act(async () => {
      resolveSave({ script_version: 4 });
      await Promise.resolve();
    });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    const st = useCreateStore.getState();
    expect(st.savedScript).toBe("Draft v2 and more");
    expect(st.scriptVersion).toBe(4);
    expect(st.saveState).toBe("saved");
  });

  it("does not save when the text returns to the saved version", () => {
    render(<Host />);
    act(() => useCreateStore.getState().setScript("Draft!"));
    act(() => useCreateStore.getState().setScript("Draft"));
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 100));
    expect(api.projects.saveScript).not.toHaveBeenCalled();
    expect(useCreateStore.getState().saveState).toBe("saved");
  });

  it("reports a failed save and keeps the text marked unsaved", async () => {
    vi.mocked(api.projects.saveScript).mockRejectedValue({ code: "DB_ERROR", message: "disk locked (synthetic)", recoverable: true });
    render(<Host />);
    act(() => useCreateStore.getState().setScript("Draft v3"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10);
    });
    expect(screen.getByText("Save failed")).toBeInTheDocument();
    const st = useCreateStore.getState();
    expect(st.savedScript).toBe("Draft");
    expect(st.error).toMatchObject({ code: "DB_ERROR", context: "save" });
  });

  it("shows word and character counts from the script", () => {
    useCreateStore.setState({ script: "one two three", savedScript: "one two three" });
    render(<Host />);
    expect(screen.getByText("3 words · 13 characters")).toBeInTheDocument();
  });
});
