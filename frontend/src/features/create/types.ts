/**
 * View-model types for the Create page. Everything here is derived from protocol shapes
 * (docs/PROTOCOL.md) plus UI-only bookkeeping such as per-segment generation status.
 */
import type { PronunciationRule, Substitution, Take } from "@/lib/protocol";

/** UI status of one planned segment. `queued`/`generating` only exist while a job runs. */
export type SegmentStatus = "none" | "queued" | "generating" | "ok" | "failed";

/** A planned segment with its takes (from `tts.plan` merged with `projects.get`). */
export interface SegmentView {
  id: string | null;
  index: number;
  paragraph: number;
  text: string;
  normalized_text: string;
  substitutions: Array<Substitution & { kind?: string }>;
  char_count: number;
  takes: Take[];
  selected_take_id: string | null;
  status: SegmentStatus;
  error: string | null;
}

/** Plan options stored under `project.settings.plan` (mirrors backend repo.plan_options). */
export interface PlanOptionsState {
  max_chars: number;
  paragraph_pause_ms: number;
  sentence_pause_ms: number;
  pronunciation: PronunciationRule[];
  spell_numbers: boolean;
}

export type JobKind = "plan" | "generate" | "assemble" | "compare";

/** What to generate; kept so a failed job can be retried with the same scope. */
export interface GenerateRequest {
  mode: "preview" | "full" | "all" | "indices";
  indices?: number[];
}

/** One in-flight worker request shown in the progress panel. Counts are measured (from progress events). */
export interface ActiveJob {
  kind: JobKind;
  requestId: string;
  label: string;
  stage: string;
  message: string;
  current: number | null;
  total: number | null;
  segmentIndex: number | null;
  startedAt: number;
  cancelling: boolean;
  request: GenerateRequest | null;
}

/** A failed job, with enough context for the recovery banner. */
export interface CreateError {
  code: string;
  message: string;
  details: Record<string, unknown>;
  recoverable: boolean;
  context: JobKind | "project" | "save" | "import";
  /** Re-runnable generate request (Retry button). */
  retry: GenerateRequest | null;
  /** Number of segments completed before the failure/cancel (from `details.completed`). */
  completed: number;
}

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export interface TextRange {
  start: number;
  end: number;
}

/** Engine comparison result for one engine (mirrors tts.compare_engines results[]). */
export interface CompareEntry {
  engine_id: string;
  take_id?: string;
  path?: string;
  loudness_matched_preview_path?: string;
  duration_s?: number | null;
  seed?: number | null;
  error?: { code: string; message: string } | null;
}

export interface CompareState {
  segmentIndex: number;
  engineIds: string[];
  results: CompareEntry[];
}
