/**
 * Synthetic fixtures for the Create page tests (src/__tests__/create*.test.tsx). Not imported by app code.
 * Shapes follow docs/PROTOCOL.md; every string is obviously synthetic.
 */
import type { Capabilities, EngineInfo, PlannedSegment, Project, Take, Voice } from "@/lib/protocol";
import type { SegmentView } from "../types";
import { toSegmentView } from "../planMath";

export const SCRIPT = "Hello there, Dr. Smith. This is the first paragraph with 3 sentences.\n\nSecond paragraph starts here. It ends now.";

export function makeCaps(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    id: "test-engine",
    name: "Test engine",
    version: "0.0.1-test",
    model_id: "test-model",
    output_sample_rate: 24000,
    languages: [
      { code: "en", label: "English", engine_value: "English" },
      { code: "de", label: "German", engine_value: "German" },
    ],
    reference: { needs_transcript: true, min_seconds: 3, max_seconds: 30, recommended_seconds: [8, 15], sample_rate: 24000, channels: 1, notes: "" },
    controls: [],
    tags: [],
    max_chars_per_request: 300,
    supports_cancel: true,
    supports_seed: true,
    supports_reusable_prompt: true,
    watermark: null,
    post_processing: [],
    cancel_granularity: "segment",
    ...overrides,
  };
}

export function makeEngine(caps: Capabilities, overrides: Partial<EngineInfo> = {}): EngineInfo {
  return { id: caps.id, name: caps.name, installed: true, state: "unloaded", model_state: "installed", model_id: caps.model_id, capabilities: caps, ...overrides };
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj_test1",
    name: "Test project",
    folder: "",
    tags: [],
    favorite: false,
    archived: false,
    voice_id: "voice_1",
    reference_id: "ref_1",
    engine_id: "test-engine",
    language: "en",
    settings: {},
    plan_version: 1,
    master_path: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function makeVoice(overrides: Partial<Voice> = {}): Voice {
  return {
    id: "voice_1",
    name: "Test voice",
    tags: [],
    language: "en",
    rights_confirmed: true,
    selected_reference_id: "ref_1",
    favorite: false,
    archived: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    references: [{ id: "ref_1", voice_id: "voice_1", asset_id: "asset_1", label: "Clip A", start_s: 1, end_s: 11.5, transcript: "This is what the reference clip says.", created_at: "2026-01-01T00:00:00Z" }],
    ...overrides,
  };
}

/** The plan `tts.plan` would produce for SCRIPT with a rule Smith→Smyth. */
export const PLANNED: PlannedSegment[] = [
  { index: 0, paragraph: 0, text: "Hello there, Dr. Smith.", normalized_text: "Hello there, Dr. Smyth.", substitutions: [{ from: "Smith", to: "Smyth", count: 1 }], char_count: 23, id: "seg_a" },
  { index: 1, paragraph: 0, text: "This is the first paragraph with 3 sentences.", normalized_text: "This is the first paragraph with 3 sentences.", substitutions: [], char_count: 45, id: "seg_b" },
  { index: 2, paragraph: 1, text: "Second paragraph starts here. It ends now.", normalized_text: "Second paragraph starts here. It ends now.", substitutions: [], char_count: 42, id: "seg_c" },
];

export function makeTake(overrides: Partial<Take> = {}): Take {
  return {
    id: "take_1",
    segment_id: "seg_a",
    project_id: "proj_test1",
    engine_id: "test-engine",
    path: "/data/projects/proj_test1/segments/seg_a/take_1.wav",
    duration_s: 2.4,
    seed: 42,
    label: null,
    status: "ok",
    created_at: "2026-01-01T00:00:01Z",
    ...overrides,
  };
}

export function plannedViews(): SegmentView[] {
  return PLANNED.map((p) => toSegmentView(p));
}
