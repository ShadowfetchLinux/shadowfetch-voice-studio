import { useReducer, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Selection } from "@/components/audio";

const h = vi.hoisted(async () => {
  const { createEventBus, makeApiModule } = await import("@/features/voices/testSupport");
  const bus = createEventBus();
  return { bus, mod: makeApiModule(bus) };
});
vi.mock("@/lib/api", async () => (await h).mod);

import { canUseTranscript, initialTranscriptState, isTranscriptStale, selectionKey, transcriptReducer } from "@/features/voices/transcriptState";
import { TranscriptStep } from "@/features/voices/TranscriptStep";
import { SaveStep } from "@/features/voices/SaveStep";
import { defaultProcessing } from "@/features/voices/processing";
import type { SourceClip } from "@/features/voices/wizardTypes";
import { useAppStore } from "@/store/appStore";
import type { Settings } from "@/lib/protocol";

const source: SourceClip = { asset_id: "a1", path: "/data/recordings/a1/working.wav", label: "Take 1", duration_s: 40, sample_rate: 48000, stats: null, origin: "recording" };
const selA: Selection = { start: 1, end: 13 };
const selB: Selection = { start: 4, end: 16 };
const keyA = selectionKey(source.path, selA);
const keyB = selectionKey(source.path, selB);
const settings = { asr_model: "faster-whisper-small.en", asr_device: "cpu", default_engine: "qwen3-tts-base", default_language: "en" } as Settings;

describe("transcript staleness gating (pure)", () => {
  it("binds a transcription to its selection and goes stale when the selection changes", () => {
    let t = transcriptReducer(initialTranscriptState, { type: "transcribed", text: "hello there", key: keyA, model: "faster-whisper-small.en", language: "en" });
    expect(t.source).toBe("asr");
    expect(isTranscriptStale(t, keyA)).toBe(false);
    expect(canUseTranscript(t, keyA)).toBe(false); // not reviewed yet
    t = transcriptReducer(t, { type: "review", reviewed: true });
    expect(canUseTranscript(t, keyA)).toBe(true);
    // selection moved → stale, review invalidated
    t = transcriptReducer(t, { type: "selectionChanged", key: keyB });
    expect(isTranscriptStale(t, keyB)).toBe(true);
    expect(t.reviewed).toBe(false);
    expect(canUseTranscript(t, keyB)).toBe(false);
    // the user confirms it still matches → bound to the new key, still needs a review
    t = transcriptReducer(t, { type: "confirmMatches", key: keyB });
    expect(isTranscriptStale(t, keyB)).toBe(false);
    expect(canUseTranscript(t, keyB)).toBe(false);
    t = transcriptReducer(t, { type: "review", reviewed: true });
    expect(canUseTranscript(t, keyB)).toBe(true);
    // re-transcribing for the new selection also clears staleness
    t = transcriptReducer(t, { type: "selectionChanged", key: keyA });
    t = transcriptReducer(t, { type: "transcribed", text: "hello again", key: keyA, model: "m", language: "en" });
    expect(isTranscriptStale(t, keyA)).toBe(false);
    expect(t.reviewed).toBe(false);
  });

  it("binds typed text to the current selection and resets the review on edits", () => {
    let t = transcriptReducer(initialTranscriptState, { type: "edit", text: "typed words", key: keyA });
    expect(t.source).toBe("edited");
    expect(t.boundKey).toBe(keyA);
    t = transcriptReducer(t, { type: "review", reviewed: true });
    t = transcriptReducer(t, { type: "edit", text: "typed words more", key: keyA });
    expect(t.reviewed).toBe(false);
    expect(isTranscriptStale(t, keyB)).toBe(true);
    expect(canUseTranscript({ ...initialTranscriptState, text: "   ", reviewed: true }, keyA)).toBe(false);
  });
});

function Host({ initial }: { initial: Selection }) {
  const [selection, setSelection] = useState<Selection>(initial);
  const [t, dispatch] = useReducer(transcriptReducer, initialTranscriptState);
  const key = selectionKey(source.path, selection);
  return (
    <div>
      <button onClick={() => { setSelection(selB); dispatch({ type: "selectionChanged", key: selectionKey(source.path, selB) }); }}>move selection</button>
      <output data-testid="can-save">{String(canUseTranscript(t, key))}</output>
      <TranscriptStep source={source} selection={selection} transcript={t} dispatch={dispatch} language="en" />
    </div>
  );
}

describe("<TranscriptStep /> with a mocked worker", () => {
  beforeEach(async () => {
    const { mod } = await h;
    vi.clearAllMocks();
    useAppStore.setState({ settings, models: [{ id: "faster-whisper-small.en", kind: "asr", repo: "Systran/faster-whisper-small.en", revision_pinned: null, license: "MIT", state: "installed" }] });
    mod.api.transcribe.run.mockResolvedValue({ text: " The quick brown fox. ", language: "en", language_probability: 0.98, segments: [], model_id: "faster-whisper-small.en", device: "cpu", duration_s: 12, elapsed_s: 1.2 });
  });

  it("transcribes the selection with the settings model, requires review, and flags a moved selection as stale", async () => {
    const { mod } = await h;
    const user = userEvent.setup();
    render(<Host initial={selA} />);
    expect(screen.getByText("faster-whisper-small.en")).toBeInTheDocument();
    const box = screen.getByRole("checkbox", { name: /I checked these words/ });
    expect(box).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Fill in the words" }));
    await waitFor(() => expect(screen.getByLabelText("Words spoken in the selection")).toHaveValue("The quick brown fox."));
    expect(mod.api.transcribe.run).toHaveBeenCalledWith({ path: source.path, start_s: 1, end_s: 13, model_id: "faster-whisper-small.en", language: "en", device: "cpu" }, expect.objectContaining({ onProgress: expect.any(Function) }));
    expect(screen.getByTestId("can-save")).toHaveTextContent("false");
    expect(box).toBeEnabled();
    await user.click(box);
    expect(screen.getByTestId("can-save")).toHaveTextContent("true");

    await user.click(screen.getByRole("button", { name: "move selection" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Selection changed — re-transcribe or confirm the transcript still matches.");
    expect(screen.getByTestId("can-save")).toHaveTextContent("false");
    expect(box).not.toBeChecked();
    expect(box).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "It still matches" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(box).toBeEnabled();
    await user.click(box);
    expect(screen.getByTestId("can-save")).toHaveTextContent("true");
    expect(screen.getByRole("button", { name: "Transcribe again" })).toBeInTheDocument();
  });
});

describe("<SaveStep /> requires the rights confirmation and sends the reviewed transcript", () => {
  beforeEach(async () => {
    const { mod } = await h;
    vi.clearAllMocks();
    useAppStore.setState({ settings, engines: [{ id: "qwen3-tts-base", name: "Qwen3-TTS 1.7B Base", installed: true, state: "unloaded", model_state: "installed" }] });
    mod.api.voices.create.mockResolvedValue({ id: "voice_1", name: "Me", tags: [], language: "en", rights_confirmed: true, selected_reference_id: "ref_1", favorite: false, archived: false, created_at: "", updated_at: "", references: [] });
  });

  it("keeps Save disabled until a name and the rights checkbox are given, then calls voices.create", async () => {
    const { mod } = await h;
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const transcript = { ...initialTranscriptState, text: "The quick brown fox.", source: "asr" as const, boundKey: keyA, reviewed: true, asrModel: "faster-whisper-small.en", language: "en" };
    render(<SaveStep mode={{ kind: "new" }} source={source} selection={selA} transcript={transcript} processing={defaultProcessing} engineId="qwen3-tts-base" onEngineChange={() => {}} caps={null} language="en" onLanguageChange={() => {}} tagSuggestions={[]} onSaved={onSaved} />);
    const save = screen.getByRole("button", { name: "Save voice" });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText("Voice name"), "Me");
    expect(save).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /This is my own voice or I have permission/ }));
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "voice_1" }), "ref_1"));
    expect(mod.api.voices.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Me", rights_confirmed: true, asset_id: "a1", trim: { start_s: 1, end_s: 13 }, transcript: "The quick brown fox.", engine_id: "qwen3-tts-base", language: "en", transcript_source: "asr", asr_model: "faster-whisper-small.en" }));
    expect(screen.getByText(/Saved "Me"/)).toBeInTheDocument();
  });

  it("refuses to save an unreviewed transcript", () => {
    const transcript = { ...initialTranscriptState, text: "words", boundKey: keyA, reviewed: false };
    render(<SaveStep mode={{ kind: "new" }} source={source} selection={selA} transcript={transcript} processing={defaultProcessing} engineId="qwen3-tts-base" onEngineChange={() => {}} caps={null} language="en" onLanguageChange={() => {}} tagSuggestions={[]} onSaved={() => {}} />);
    expect(screen.getByRole("button", { name: "Save voice" })).toBeDisabled();
    expect(screen.getByText("Confirm the transcript in step 3 first.")).toBeInTheDocument();
  });
});
