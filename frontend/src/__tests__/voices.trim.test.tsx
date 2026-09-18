import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Capabilities, ReferenceRequirements } from "@/lib/protocol";

const h = vi.hoisted(async () => {
  const { createEventBus, makeApiModule } = await import("@/features/voices/testSupport");
  const bus = createEventBus();
  return { bus, mod: makeApiModule(bus) };
});
vi.mock("@/lib/api", async () => (await h).mod);

import { suggestSelection, validateSelection } from "@/features/voices/trimValidation";
import { defaultProcessing, toPreviewProcessing, toProcessingSteps } from "@/features/voices/processing";
import { ReviewStep } from "@/features/voices/ReviewStep";
import type { SourceClip } from "@/features/voices/wizardTypes";

const ref: ReferenceRequirements = { needs_transcript: true, min_seconds: 3, max_seconds: 30, recommended_seconds: [8, 15], sample_rate: 24000, channels: 1, notes: "" };
const caps: Capabilities = {
  id: "qwen3-tts-base",
  name: "Qwen3-TTS 1.7B Base",
  version: "1",
  model_id: "m",
  output_sample_rate: 24000,
  languages: [{ code: "en", label: "English", engine_value: "English" }],
  reference: ref,
  controls: [],
  tags: [],
  max_chars_per_request: 400,
  supports_cancel: true,
  supports_seed: true,
  supports_reusable_prompt: true,
  watermark: null,
  post_processing: [],
  cancel_granularity: "segment",
};

describe("trim validation against Capabilities.reference", () => {
  it("suggests the upper recommended length, capped by the clip and the engine maximum", () => {
    expect(suggestSelection(60, ref)).toEqual({ start: 0, end: 15 });
    expect(suggestSelection(60, ref, 2.5)).toEqual({ start: 2.4, end: 17.4 });
    expect(suggestSelection(9, ref)).toEqual({ start: 0, end: 9 });
    // no engine limits → the 10–15 s default from the workflow spec
    expect(suggestSelection(60, null)).toEqual({ start: 0, end: 15 });
    // recommendation above the engine maximum is clamped to the maximum
    expect(suggestSelection(60, { ...ref, recommended_seconds: [20, 40], max_seconds: 30 })).toEqual({ start: 0, end: 30 });
    expect(suggestSelection(0, ref)).toBeNull();
  });

  it("classifies selections as ok / warn / error using the engine limits only", () => {
    expect(validateSelection(null, ref).level).toBe("error");
    expect(validateSelection({ start: 0, end: 2 }, ref)).toMatchObject({ level: "error", message: expect.stringMatching(/at least 3 s/) });
    expect(validateSelection({ start: 0, end: 31 }, ref)).toMatchObject({ level: "error", message: expect.stringMatching(/at most 30 s/) });
    expect(validateSelection({ start: 5, end: 10 }, ref)).toMatchObject({ level: "warn", message: expect.stringMatching(/recommended 8–15 s/) });
    expect(validateSelection({ start: 5, end: 17 }, ref)).toMatchObject({ level: "ok", duration_s: 12 });
    // without capabilities the UI must not pretend to know the limits
    expect(validateSelection({ start: 0, end: 12 }, null)).toMatchObject({ level: "warn", message: expect.stringMatching(/No engine limits/) });
    expect(validateSelection({ start: 0, end: 0.2 }, null).level).toBe("error");
  });

  it("encodes processing choices for preview and for the stored reference", () => {
    expect(toPreviewProcessing(defaultProcessing)).toEqual({});
    expect(toProcessingSteps(defaultProcessing)).toEqual([]);
    const on = { ...defaultProcessing, normalize: true, normalizeDbfs: -3, trimSilence: true, highpass: true, highpassHz: 80 };
    expect(toPreviewProcessing(on)).toEqual({ trim_silence: true, highpass_hz: 80, normalize_peak_dbfs: -3 });
    expect(toProcessingSteps(on)).toEqual([{ op: "trim_silence" }, { op: "highpass", hz: 80 }, { op: "normalize_peak", id: "normalize_peak", dbfs: -3 }]);
  });
});

describe("<ReviewStep /> shows the engine limits live", () => {
  const source: SourceClip = { asset_id: "a1", path: "/data/recordings/a1/working.wav", label: "Take 1", duration_s: 40, sample_rate: 48000, stats: null, origin: "recording" };

  beforeEach(async () => {
    const { mod } = await h;
    vi.clearAllMocks();
    mod.api.audio.peaks.mockResolvedValue({ points: 4, duration_s: 40, sample_rate: 48000, peaks: [[-0.5, 0.5], [-0.2, 0.2], [-0.8, 0.8], [-0.1, 0.1]] });
    mod.api.audio.stats.mockResolvedValue({ duration_s: 15, sample_rate: 48000, channels: 1, peak_dbfs: -3.1, rms_dbfs: -18.4, clipping_samples: 0, leading_silence_s: 0, trailing_silence_s: 0, silence_ratio: 0.05, warnings: [{ code: "NOISY", message: "Background noise floor is high.", heuristic: true }] });
  });

  it("suggests a selection, then re-validates every change against min/max", async () => {
    const { mod } = await h;
    const onSelectionChange = vi.fn();
    const { rerender } = render(<ReviewStep source={source} caps={caps} capsError={null} selection={null} onSelectionChange={onSelectionChange} processing={defaultProcessing} onProcessingChange={() => {}} />);
    await waitFor(() => expect(onSelectionChange).toHaveBeenCalledWith({ start: 0, end: 15 }));
    expect(screen.getByText(/needs 3–30 s of reference audio/)).toBeInTheDocument();

    rerender(<ReviewStep source={source} caps={caps} capsError={null} selection={{ start: 0, end: 15 }} onSelectionChange={onSelectionChange} processing={defaultProcessing} onProcessingChange={() => {}} />);
    expect(screen.getByTestId("trim-verdict")).toHaveTextContent("within the recommended 8–15 s");
    await waitFor(() => expect(mod.api.audio.stats).toHaveBeenCalledWith({ path: source.path, start_s: 0, end_s: 15 }));
    await waitFor(() => expect(screen.getByText("-3.1 dBFS")).toBeInTheDocument());
    expect(screen.getByText(/Background noise floor is high/)).toBeInTheDocument();
    expect(screen.getAllByText(/heuristic/).length).toBeGreaterThan(0);

    rerender(<ReviewStep source={source} caps={caps} capsError={null} selection={{ start: 0, end: 2 }} onSelectionChange={onSelectionChange} processing={defaultProcessing} onProcessingChange={() => {}} />);
    expect(screen.getByTestId("trim-verdict")).toHaveTextContent("Too short");
    rerender(<ReviewStep source={source} caps={caps} capsError={null} selection={{ start: 0, end: 35 }} onSelectionChange={onSelectionChange} processing={defaultProcessing} onProcessingChange={() => {}} />);
    expect(screen.getByTestId("trim-verdict")).toHaveTextContent("Too long");
    rerender(<ReviewStep source={source} caps={caps} capsError={null} selection={{ start: 0, end: 20 }} onSelectionChange={onSelectionChange} processing={defaultProcessing} onProcessingChange={() => {}} />);
    expect(screen.getByTestId("trim-verdict")).toHaveTextContent("outside the recommended");
  });

  it("says so when the engine cannot report its limits", async () => {
    render(<ReviewStep source={source} caps={null} capsError="Environment for chatterbox-turbo is not installed" selection={{ start: 0, end: 12 }} onSelectionChange={() => {}} processing={defaultProcessing} onProcessingChange={() => {}} />);
    expect(screen.getByText(/Engine limits unavailable/)).toBeInTheDocument();
    expect(screen.getByTestId("trim-verdict")).toHaveTextContent("No engine limits available");
  });
});
