import { describe, expect, it } from "vitest";
import type { Selection } from "@/components/audio";

import { initialTranscriptState, isTranscriptStale, selectionKey, transcriptReducer, type TranscriptState } from "@/features/voices/transcriptState";
import { defaultProcessing, processingFromSteps, toProcessingSteps } from "@/features/voices/processing";

const source = { path: "/data/recordings/a1/working.wav" };
const selA: Selection = { start: 1, end: 13 };
const selB: Selection = { start: 4, end: 16 };
const keyA = selectionKey(source.path, selA);
const keyB = selectionKey(source.path, selB);

/** Usable words: non-empty, reviewed, and bound to the current selection. */
const canUseTranscript = (t: TranscriptState, key: string) => t.text.trim().length > 0 && t.reviewed && !isTranscriptStale(t, key);

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

describe("stored clean-up steps", () => {
  it("round-trip between the editor options and the stored processing list", () => {
    const opts = { ...defaultProcessing, normalize: true, normalizeDbfs: -2, highpass: true, highpassHz: 100 };
    expect(processingFromSteps(toProcessingSteps(opts))).toEqual(opts);
    expect(processingFromSteps([])).toEqual(defaultProcessing);
    expect(processingFromSteps([{ op: "unknown" }, null, "x"])).toEqual(defaultProcessing);
  });
});
