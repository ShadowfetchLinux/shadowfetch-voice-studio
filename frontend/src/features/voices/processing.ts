/**
 * Optional reference processing (off by default). Two encodings of the same choices:
 * - `toPreviewProcessing` → the compact object `audio.preview_processing` accepts;
 * - `toProcessingSteps`  → the ordered `{op, ...}` step list stored with the voice reference.
 */
import type { ReferenceProcessing } from "@/lib/protocol";

export interface ProcessingOptions {
  normalize: boolean;
  normalizeDbfs: number;
  trimSilence: boolean;
  highpass: boolean;
  highpassHz: number;
}

export const defaultProcessing: ProcessingOptions = { normalize: false, normalizeDbfs: -3, trimSilence: false, highpass: false, highpassHz: 80 };

export function isProcessingActive(p: ProcessingOptions): boolean {
  return p.normalize || p.trimSilence || p.highpass;
}

export function toPreviewProcessing(p: ProcessingOptions): ReferenceProcessing {
  const out: ReferenceProcessing = {};
  if (p.trimSilence) out.trim_silence = true;
  if (p.highpass) out.highpass_hz = p.highpassHz;
  if (p.normalize) out.normalize_peak_dbfs = p.normalizeDbfs;
  return out;
}

/** Ordered steps (`trim_silence` → `highpass` → `normalize_peak`), matching the worker's own ordering. */
export function toProcessingSteps(p: ProcessingOptions): Array<Record<string, unknown>> {
  const steps: Array<Record<string, unknown>> = [];
  if (p.trimSilence) steps.push({ op: "trim_silence" });
  if (p.highpass) steps.push({ op: "highpass", hz: p.highpassHz });
  // `id` duplicates `op` so the worker's normalize lookup (`repo.normalize_peak_from`) finds the value.
  if (p.normalize) steps.push({ op: "normalize_peak", id: "normalize_peak", dbfs: p.normalizeDbfs });
  return steps;
}

/** Ordered human labels for the stored processing list (the profile's processing history). */
export function processingSteps(steps: unknown[] | null | undefined): string[] {
  if (!steps || steps.length === 0) return [];
  const parts: string[] = [];
  for (const s of steps) {
    if (!s || typeof s !== "object") continue;
    const step = s as Record<string, unknown>;
    const op = String(step.op ?? step.id ?? "");
    if (op === "trim_silence") parts.push("trim silence");
    else if (op === "highpass") parts.push(`high-pass ${step.hz ?? ""} Hz`);
    else if (op === "normalize_peak" || op === "normalize") parts.push(`normalize ${step.dbfs ?? step.normalize_peak_dbfs ?? ""} dBFS`);
    else if (op) parts.push(op);
  }
  return parts;
}

/** Inverse of `toProcessingSteps`: a stored processing list → the editor's options (unknown steps are ignored). */
export function processingFromSteps(steps: unknown[] | null | undefined): ProcessingOptions {
  const out: ProcessingOptions = { ...defaultProcessing };
  for (const s of steps ?? []) {
    if (!s || typeof s !== "object") continue;
    const step = s as Record<string, unknown>;
    const op = String(step.op ?? step.id ?? "");
    if (op === "trim_silence") out.trimSilence = true;
    else if (op === "highpass") {
      out.highpass = true;
      if (typeof step.hz === "number") out.highpassHz = step.hz;
    } else if (op === "normalize_peak" || op === "normalize") {
      out.normalize = true;
      const db = step.dbfs ?? step.normalize_peak_dbfs;
      if (typeof db === "number") out.normalizeDbfs = db;
    }
  }
  return out;
}
