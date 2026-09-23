/**
 * Clone Voice, the automatic part (no React): after a recording or an imported file is registered as an asset,
 * pick a clean reference range and transcribe exactly that range. Every saved voice keeps its words next to its audio
 * (the source of truth, see docs/ARCHITECTURE.md), whichever engine speaks with it later.
 *
 *   audio.suggest_reference  → range + plain problems (quiet, clipped, noisy, too little speech)
 *   transcribe.run           → the words spoken in that range (faster-whisper, local)
 *
 * The result decides the next screen: ready / problems / edit by hand (see `nextStage`).
 */
import { api, type RequestPromise } from "@/lib/api";
import type { ReferenceRequirements, SampleIssue, SuggestReferenceResult, TranscribeResult } from "@/lib/protocol";
import type { Selection } from "@/components/audio";
import { selectionKey, type TranscriptState } from "../transcriptState";

/** The audio the flow continues with. `path` is the decoded working copy (float32 mono 48 kHz). */
export interface SampleSource {
  assetId: string;
  path: string;
  origin: "recording" | "import";
  name: string;
  durationS: number;
}

export interface Analysis {
  suggestion: SuggestReferenceResult;
  selection: Selection;
  transcript: TranscriptState | null;
  /** Mean token probability of the transcript (0..1) when the model reported one. */
  confidence: number | null;
  blocking: SampleIssue[];
  warnings: SampleIssue[];
}

/** Below this the words deserve a look ("Some words may have been misheard"). */
export const LOW_CONFIDENCE = 0.6;

export interface AnalyzeOptions {
  engineId: string | null;
  asrModel?: string | null;
  asrDevice?: "cpu" | "cuda";
  language: string;
  /** Receives the in-flight request so the dialog can cancel it. */
  onRequest?: (r: RequestPromise<unknown> | null) => void;
  onStage?: (stage: "checking" | "words") => void;
}

export async function analyzeSample(src: SampleSource, opts: AnalyzeOptions): Promise<Analysis> {
  opts.onStage?.("checking");
  const sreq = api.audio.suggestReference({ asset_id: src.assetId, ...(opts.engineId ? { engine_id: opts.engineId } : {}) });
  opts.onRequest?.(sreq);
  const suggestion = await sreq;
  const selection = { start: suggestion.start_s, end: suggestion.end_s };
  const blocking = suggestion.issues.filter((i) => i.severity === "block");
  const warnings = suggestion.issues.filter((i) => i.severity !== "block");
  let transcript: TranscriptState | null = null;
  let confidence: number | null = null;
  if (blocking.length === 0 && suggestion.reliable) {
    opts.onStage?.("words");
    const treq = api.transcribe.run({ path: src.path, start_s: selection.start, end_s: selection.end, model_id: opts.asrModel ?? undefined, device: opts.asrDevice, language: opts.language });
    opts.onRequest?.(treq);
    const r: TranscribeResult = await treq;
    transcript = { text: r.text.trim(), source: "asr", boundKey: selectionKey(src.path, selection), reviewed: false, asrModel: r.model_id, language: r.language };
    confidence = r.confidence ?? null;
  }
  opts.onRequest?.(null);
  return { suggestion, selection, transcript, confidence, blocking, warnings };
}

export type NextStage = "ready" | "problem" | "edit";

/** Blocking problems or warnings → "problem"; no clean phrase-aligned range (or no words) → "edit" (by hand); else "ready". */
export function nextStage(a: Analysis): NextStage {
  if (a.blocking.length) return "problem";
  if (!a.suggestion.reliable) return "edit";
  if (!a.transcript?.text) return "edit";
  if (a.warnings.some((w) => w.code !== "SHORT")) return "problem";
  return "ready";
}

/** Engine reference limits, with the Qwen defaults when the engine did not report any. */
export function referenceLimits(ref: ReferenceRequirements | null | undefined): ReferenceRequirements {
  return ref ?? { needs_transcript: true, min_seconds: 3, max_seconds: 30, recommended_seconds: [8, 15], sample_rate: 24000, channels: 1, notes: "" };
}
