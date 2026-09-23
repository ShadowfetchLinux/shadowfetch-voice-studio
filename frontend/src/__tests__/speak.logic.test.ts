/** Pure logic behind the simple screens: model readiness, plain-language errors, progress labels, file names. */
import { describe, expect, it } from "vitest";
import { describeIssue, friendlyError } from "@/lib/friendlyErrors";
import { WorkerError } from "@/lib/protocol";
import { readiness, speakEngineId } from "@/store/modelSetup";
import { stepFromProgress, stepLabel, type SpeakRun } from "@/features/speak/speakStore";
import { fileNameFor, renderParams } from "@/features/speak/saveAudio";
import { plainVerdict } from "@/features/voices/clone/SampleEditor";
import { nextStage, type Analysis } from "@/features/voices/clone/cloneFlow";
import { SETTINGS, engines, entry, models } from "@/features/speak/testing/fixtures";
import type { Settings } from "@/lib/protocol";

describe("model readiness", () => {
  it("Speak needs the voice model; Clone needs speech recognition and offers the voice model too", () => {
    expect(readiness("speak", engines(), models(), SETTINGS).ready).toBe(true);
    const speak = readiness("speak", engines(), models({ tts: "missing" }), SETTINGS);
    expect(speak.ready).toBe(false);
    expect(speak.needs.map((n) => [n.model.id, n.required])).toEqual([["qwen3-tts-12hz-1.7b-base", true]]);

    const clone = readiness("clone", engines(), models({ tts: "missing", asr: "missing" }), SETTINGS);
    expect(clone.ready).toBe(false);
    expect(clone.needs.map((n) => [n.model.id, n.required])).toEqual([
      ["faster-whisper-small.en", true],
      ["qwen3-tts-12hz-1.7b-base", false],
    ]);
    // cloning does not block on the voice model
    expect(readiness("clone", engines(), models({ tts: "missing" }), SETTINGS).ready).toBe(true);
  });

  it("an incomplete / errored model counts as missing, and so does one still downloading (the worker refuses it until verified)", () => {
    expect(readiness("speak", engines(), models({ tts: "error" }), SETTINGS).ready).toBe(false);
    expect(readiness("speak", engines(), models({ tts: "downloading" }), SETTINGS).ready).toBe(false);
    expect(readiness("speak", engines(), models({ tts: "verifying" }), SETTINGS).ready).toBe(false);
  });

  it("a missing engine environment is reported (downloads cannot fix it); unknown lists do not block", () => {
    const r = readiness("speak", engines({ qwenInstalled: false }), models(), SETTINGS);
    expect(r.engineMissing?.id).toBe("qwen3-tts-base");
    expect(r.ready).toBe(false);
    expect(readiness("speak", [], [], null).ready).toBe(true);
  });

  it("uses the Advanced engine override only when that engine is installed", () => {
    const list = engines({ chatterbox: true });
    expect(speakEngineId(list, SETTINGS, null)).toBe("qwen3-tts-base");
    expect(speakEngineId(list, SETTINGS, "chatterbox-turbo")).toBe("chatterbox-turbo");
    expect(speakEngineId(engines(), SETTINGS, "chatterbox-turbo")).toBe("qwen3-tts-base");
    expect(speakEngineId(list, { ...SETTINGS, default_engine: "nope" } as Settings, null)).toBe("qwen3-tts-base");
  });
});

describe("plain-language errors", () => {
  const f = (code: string, ctx?: Parameters<typeof friendlyError>[1]) => friendlyError(new WorkerError({ code, message: `raw ${code}` }), ctx);
  it("uses the wording from the product brief and keeps the technical error", () => {
    expect(f("GPU_OOM").message).toBe("Your GPU ran out of memory while generating this speech. Close other GPU-heavy applications and try again.");
    expect(f("MODEL_MISSING", "speak").message).toBe("The local voice model needs to be installed before Voice Studio can speak.");
    expect(f("MODEL_MISSING", "speak").action).toBe("install-model");
    expect(f("DEVICE_UNAVAILABLE", "record").message).toBe("Voice Studio can't access that microphone. Choose another microphone or reconnect it.");
    expect(f("GPU_OOM").technical).toBe("GPU_OOM: raw GPU_OOM");
    for (const code of ["ENGINE_CRASHED", "OFFLINE_BLOCKED", "DISK_FULL", "UNSUPPORTED_FILE", "CORRUPT_FILE", "FFMPEG_FAILED", "INTERNAL", "SOMETHING_NEW"]) {
      expect(f(code).message).not.toMatch(/_[A-Z]|raw /);
    }
    expect(describeIssue({ code: "MOSTLY_SILENT" })).toBe("This recording contains a lot of silence.");
    expect(describeIssue({ code: "TOO_QUIET" })).toBe("The recording is very quiet. Move closer to the microphone or choose another sample.");
    expect(describeIssue({ code: "NO_SPEECH" })).toBe("Very little speech was detected in this recording.");
    expect(describeIssue({ code: "NOISY" })).toBe("The voice is difficult to hear over the background noise.");
  });
});

describe("Speak progress wording", () => {
  const run = (over: Partial<SpeakRun>): SpeakRun => ({ id: 1, step: "prepare", current: null, total: null, cancelling: false, requestId: null, ...over });
  it("shows sentence counts only for longer text, and plain words for loading", () => {
    expect(stepLabel(null)).toBe("Speak");
    expect(stepLabel(run({ step: "generate", current: 1, total: 1 }))).toBe("Generating speech…");
    expect(stepLabel(run({ step: "generate", current: 3, total: 12 }))).toBe("Generating speech — 3 of 12");
    expect(stepLabel(run({ step: "load" }))).toBe("Loading the voice model…");
    expect(stepLabel(run({ step: "queued" }))).toBe("Waiting for another task…");
    expect(stepLabel(run({ step: "generate", cancelling: true }))).toBe("Stopping…");
    expect(stepFromProgress({ id: "x", stage: "engine", message: "Loading Qwen weights" }).step).toBe("load");
    expect(stepFromProgress({ id: "x", stage: "generate", message: "", current: 2, total: 5 })).toEqual({ step: "generate", current: 2, total: 5 });
  });
});

describe("Save Audio", () => {
  it("names the file after the text and renders with the saved preferences", () => {
    expect(fileNameFor("Welcome to Shadowfetch. This is my cloned voice speaking from my own computer.")).toBe("Welcome to Shadowfetch This is my cloned voice");
    expect(fileNameFor("…!!!")).toBe("Speech");
    const e = entry("Hi.");
    expect(renderParams(e, "wav", "/out.wav", SETTINGS)).toEqual({ project_id: "proj_speak", master_path: e.path, format: "wav", out_path: "/out.wav", wav_bit_depth: 24, ai_metadata: true });
    expect(renderParams(e, "mp3", "/out.mp3", { ...SETTINGS, export_mp3_bitrate_kbps: 320, export_loudness_target: "podcast-16" } as Settings)).toMatchObject({ mp3_bitrate_kbps: 320, loudness: { target_id: "podcast-16" } });
    expect(renderParams(e, "flac", "/out.flac", SETTINGS)).not.toHaveProperty("wav_bit_depth");
  });
});

describe("clone decisions", () => {
  const ref = { needs_transcript: true, min_seconds: 3, max_seconds: 30, recommended_seconds: [8, 15] as [number, number], sample_rate: 24000, channels: 1, notes: "" };
  it("judges the selected length in plain words", () => {
    expect(plainVerdict({ start: 0, end: 12 }, ref)).toEqual({ level: "ok", text: "12.0 seconds selected — a good length." });
    expect(plainVerdict({ start: 0, end: 2.5 }, ref).level).toBe("error");
    expect(plainVerdict({ start: 0, end: 40 }, ref).level).toBe("error");
    expect(plainVerdict({ start: 0, end: 20 }, ref).level).toBe("warn");
  });

  it("goes to ready, problems, or the trim editor", () => {
    const base: Analysis = {
      suggestion: { start_s: 1, end_s: 12, duration_s: 11, reliable: true, edges_clean: true, speech_ratio: 0.9, speech_s: 20, total_s: 30, snr_db: 40, peak_dbfs: -6, issues: [], recommended_seconds: [8, 15], min_seconds: 3, max_seconds: 30, engine_id: "q", path: "/p" },
      selection: { start: 1, end: 12 },
      transcript: { text: "words", source: "asr", boundKey: "k", reviewed: false, asrModel: "m", language: "en" },
      confidence: 0.9,
      blocking: [],
      warnings: [],
    };
    expect(nextStage(base)).toBe("ready");
    expect(nextStage({ ...base, warnings: [{ code: "SHORT", message: "", severity: "warn", heuristic: true }] })).toBe("ready");
    expect(nextStage({ ...base, warnings: [{ code: "CLIPPING", message: "", severity: "warn", heuristic: true }] })).toBe("problem");
    expect(nextStage({ ...base, blocking: [{ code: "NO_SPEECH", message: "", severity: "block", heuristic: true }] })).toBe("problem");
    expect(nextStage({ ...base, suggestion: { ...base.suggestion, reliable: false } })).toBe("edit");
    expect(nextStage({ ...base, transcript: null })).toBe("edit");
  });
});
