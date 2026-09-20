import type { AudioStats, Voice } from "@/lib/protocol";

/** The audio the workflow continues with (a recorded take or an imported file, registered as an asset). */
export interface SourceClip {
  asset_id: string;
  /** File to play/analyse: the worker's working.wav (float32 mono 48 kHz) when it exists, else the original. */
  path: string;
  label: string;
  duration_s: number;
  sample_rate: number | null;
  stats: AudioStats | null;
  origin: "recording" | "import";
}

export type SourceMode = "record" | "import";

export type WizardMode = { kind: "new" } | { kind: "addReference"; voice: Voice };

export type WizardStep = 1 | 2 | 3 | 4;

export const STEP_TITLES: Record<WizardStep, string> = { 1: "Audio", 2: "Trim", 3: "Words", 4: "Save" };
