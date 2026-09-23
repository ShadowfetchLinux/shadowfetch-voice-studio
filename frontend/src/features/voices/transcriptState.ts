/**
 * Transcript review state for the "New voice" workflow (pure; unit-tested).
 *
 * A transcript is bound to the exact audio range it describes (`boundKey`). When the selection changes
 * afterwards the transcript is *stale*: the user must re-transcribe or explicitly confirm it still matches.
 * Saving additionally requires the "I reviewed this transcript" checkbox.
 */
import type { Selection } from "@/components/audio/waveformMath";

export interface TranscriptState {
  text: string;
  /** How the current text came to be: worker ASR, or typed/edited by the user. */
  source: "asr" | "edited" | null;
  /** Selection key the text was transcribed/confirmed for (null = never bound). */
  boundKey: string | null;
  reviewed: boolean;
  /** ASR model used for the last transcription (kept for the reference row). */
  asrModel: string | null;
  language: string | null;
}

export const initialTranscriptState: TranscriptState = { text: "", source: null, boundKey: null, reviewed: false, asrModel: null, language: null };

/** Stable identity of a (file, range) pair; 3-decimal seconds so handle jitter below 1 ms does not count. */
export function selectionKey(path: string | null, sel: Selection | null): string {
  if (!path || !sel) return "";
  return `${path}|${sel.start.toFixed(3)}|${sel.end.toFixed(3)}`;
}

export function isTranscriptStale(t: TranscriptState, currentKey: string): boolean {
  return t.boundKey != null && currentKey !== "" && t.boundKey !== currentKey;
}

export type TranscriptAction =
  | { type: "transcribed"; text: string; key: string; model: string; language: string }
  | { type: "edit"; text: string; key: string }
  | { type: "review"; reviewed: boolean }
  | { type: "confirmMatches"; key: string }
  | { type: "selectionChanged"; key: string }
  | { type: "reset" };

export function transcriptReducer(t: TranscriptState, a: TranscriptAction): TranscriptState {
  switch (a.type) {
    case "transcribed":
      return { text: a.text, source: "asr", boundKey: a.key, reviewed: false, asrModel: a.model, language: a.language };
    case "edit":
      // typing binds a fresh transcript to the current selection; editing an ASR result keeps its binding
      return { ...t, text: a.text, source: "edited", boundKey: t.boundKey ?? (a.text.trim() ? a.key : null), reviewed: false };
    case "review":
      return { ...t, reviewed: a.reviewed };
    case "confirmMatches":
      return { ...t, boundKey: a.key };
    case "selectionChanged":
      // becoming stale invalidates the review; nothing else changes (the text is kept for the user)
      return isTranscriptStale(t, a.key) ? { ...t, reviewed: false } : t;
    case "reset":
      return initialTranscriptState;
    default:
      return t;
  }
}
