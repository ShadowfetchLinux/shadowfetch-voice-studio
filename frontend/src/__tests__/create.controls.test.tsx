import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { api } from "@/lib/api";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api", () => ({
  api: {
    request: vi.fn(),
    requestRaw: vi.fn(),
    cancel: vi.fn(async () => {}),
    events: { on: () => () => {}, onWorkerStatus: () => () => {}, onRuntimeLog: () => () => {} },
    projects: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(async () => ({})), saveScript: vi.fn(), selectTake: vi.fn() },
    voices: { list: vi.fn() },
    tts: { plan: vi.fn(), assemble: vi.fn(), compareEngines: vi.fn() },
    audio: { peaks: vi.fn() },
    shell: { pickTextFile: vi.fn(), readTextFile: vi.fn(), fileSrc: (p: string) => p, mediaSrc: async (p: string) => p, releaseMediaSrc: () => undefined },
  },
  isPreviewMock: () => false,
  isTauri: () => false,
}));

import type { ControlSpec } from "@/lib/protocol";
import { useAppStore } from "@/store/appStore";
import { EnginePanel } from "@/features/create/components/EnginePanel";
import { __resetCreateStore, declaredPostProcessing, useCreateStore } from "@/features/create/createStore";
import { makeCaps, makeEngine } from "@/features/create/testing/fixtures";

const CONTROLS: ControlSpec[] = [
  { id: "temperature", label: "Sampling temperature", type: "float", min: 0.1, max: 1.5, step: 0.05, default: 0.9 },
  { id: "fast", label: "Fast mode", type: "bool", default: false, description: "engine flag" },
  { id: "style", label: "Style", type: "enum", default: "neutral", options: [{ value: "neutral", label: "Neutral" }, { value: "warm", label: "Warm" }] },
  { id: "top_k", label: "Top-k", type: "int", min: 1, max: 100, step: 1, default: 50, advanced: true },
];

function renderPanel(capsOverrides: Parameters<typeof makeCaps>[0]) {
  const caps = makeCaps(capsOverrides);
  const engine = makeEngine(caps);
  useAppStore.setState({ engines: [engine], engineStates: {} });
  useCreateStore.setState({ projectId: "proj_test1", engineId: caps.id, language: "en" });
  return render(<EnginePanel engines={[engine]} caps={caps} />);
}

describe("capability-driven controls", () => {
  beforeEach(() => {
    __resetCreateStore();
    vi.clearAllMocks();
  });

  it("renders no generation settings, no tag palette and no post-processing when the engine declared none", () => {
    renderPanel({ controls: [], tags: [], post_processing: [] });
    expect(screen.queryByText("Generation settings")).not.toBeInTheDocument();
    expect(screen.queryByTestId("capability-controls")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tag-palette")).not.toBeInTheDocument();
    expect(screen.queryByText("Post-processing")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
    // engine + language selects and the segmentation disclosure are still there
    expect(screen.getByRole("combobox", { name: "Engine" })).toHaveValue("test-engine");
    expect(screen.getByRole("combobox", { name: "Language" })).toHaveValue("en");
    expect(screen.getByRole("button", { name: /Segmentation/ })).toBeInTheDocument();
  });

  it("renders exactly the declared controls (slider, switch, select) with advanced ones collapsed", async () => {
    const user = userEvent.setup();
    renderPanel({ controls: CONTROLS });
    expect(screen.getByText("Generation settings")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Sampling temperature" })).toHaveValue("0.9");
    expect(screen.getByRole("switch", { name: /Fast mode/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("combobox", { name: "Style" })).toHaveValue("neutral");
    // advanced control hidden until the disclosure opens
    expect(screen.queryByRole("slider", { name: "Top-k" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Advanced generation settings/ }));
    expect(screen.getByRole("slider", { name: "Top-k" })).toHaveValue("50");
    // exactly the four declared controls, nothing invented
    expect(screen.getAllByRole("slider")).toHaveLength(2);

    await user.click(screen.getByRole("switch", { name: /Fast mode/ }));
    expect(useCreateStore.getState().controls["test-engine"]).toEqual({ fast: true });
    await user.selectOptions(screen.getByRole("combobox", { name: "Style" }), "warm");
    expect(useCreateStore.getState().controls["test-engine"]).toEqual({ fast: true, style: "warm" });
  });

  it("shows the tag palette only when tags are declared and inserts the token into the script", async () => {
    const user = userEvent.setup();
    useCreateStore.setState({ script: "Hello" });
    renderPanel({ tags: [{ token: "[laugh]", label: "Laugh" }, { token: "[sigh]", label: "Sigh", description: "a sigh" }] });
    const palette = screen.getByTestId("tag-palette");
    expect(palette).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Expression tags" }).querySelectorAll("button")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /Laugh/ }));
    // no editor mounted → appended at the end, padded with a space
    expect(useCreateStore.getState().script).toBe("Hello [laugh]");
  });

  it("labels post-processing controls as post-processing and hides the seed when unsupported", () => {
    renderPanel({ supports_seed: false, post_processing: [{ id: "speed", label: "Speed (post-processing)", type: "float", min: 0.8, max: 1.25, step: 0.01, default: 1 }] });
    expect(screen.getByText("Post-processing")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Speed (post-processing)" })).toHaveValue("1");
    expect(screen.queryByLabelText(/Seed/)).not.toBeInTheDocument();
  });

  it("persists post-processing values only for engines that declare such controls", async () => {
    const speed: ControlSpec = { id: "speed", label: "Speed (post-processing)", type: "float", min: 0.8, max: 1.25, step: 0.01, default: 1 };
    const plain = makeCaps({ id: "plain-engine", post_processing: [] });
    const withPost = makeCaps({ id: "post-engine", post_processing: [speed] });
    useAppStore.setState({ engines: [makeEngine(plain), makeEngine(withPost)], engineStates: {} });
    // pure helper: undeclared ids (or engines without post-processing at all) are dropped; nothing → null
    expect(declaredPostProcessing({})).toBeNull();
    expect(declaredPostProcessing({ "plain-engine": { speed: 1.1 } })).toBeNull();
    expect(declaredPostProcessing({ "post-engine": { speed: 1.1, bogus: 3 }, "plain-engine": { speed: 0.9 } })).toEqual({ "post-engine": { speed: 1.1 } });

    // through the store: the debounced projects.update carries no post_processing key for an engine without controls
    vi.useFakeTimers();
    try {
      useCreateStore.setState({ projectId: "proj_test1", engineId: "plain-engine", postProcessing: { "plain-engine": { speed: 1.1 } } });
      useCreateStore.getState().setSeed(7);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      const update = vi.mocked(api.projects.update);
      expect(update).toHaveBeenCalledTimes(1);
      const settings = update.mock.calls[0]![0].patch.settings as Record<string, unknown>;
      expect(settings).not.toHaveProperty("post_processing");
      expect(settings).toMatchObject({ seed: 7, controls: {} });

      useCreateStore.getState().setPostProcessing("post-engine", "speed", 1.2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(update).toHaveBeenCalledTimes(2);
      expect((update.mock.calls[1]![0].patch.settings as Record<string, unknown>).post_processing).toEqual({ "post-engine": { speed: 1.2 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers the seed input with the environment caveat when the engine supports seeds", () => {
    renderPanel({ supports_seed: true });
    expect(screen.getByLabelText("Seed (optional)")).toBeInTheDocument();
    expect(screen.getByText(/does not guarantee identical output across environments/)).toBeInTheDocument();
  });

  it("links to Settings when the model for the selected engine is missing", () => {
    const caps = makeCaps();
    const engine = makeEngine(caps, { model_state: "missing" });
    useAppStore.setState({ engines: [engine], engineStates: {} });
    useCreateStore.setState({ projectId: "proj_test1", engineId: caps.id });
    render(<EnginePanel engines={[engine]} caps={caps} />);
    expect(screen.getByText("model missing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install the model in Settings" })).toBeInTheDocument();
  });
});
