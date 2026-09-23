/**
 * Test fixtures for the Speak / Voices / Clone flows: voices with references, engine list with capabilities,
 * installed models, and helpers to control mocked worker requests (pending promises that carry a request id).
 */
import type { Capabilities, EngineInfo, ModelInfo, Settings, SpeakSession, SpeechEntry, Voice } from "@/lib/protocol";

export const QWEN_CAPS: Capabilities = {
  id: "qwen3-tts-base",
  name: "Qwen3-TTS 1.7B Base",
  version: "0.1.1",
  model_id: "qwen3-tts-12hz-1.7b-base",
  output_sample_rate: 24000,
  languages: [
    { code: "en", label: "English", engine_value: "English" },
    { code: "de", label: "German", engine_value: "German" },
  ],
  reference: { needs_transcript: true, min_seconds: 3, max_seconds: 30, recommended_seconds: [8, 15], sample_rate: 24000, channels: 1, notes: "" },
  controls: [
    { id: "temperature", label: "Sampling temperature", type: "float", min: 0.1, max: 1.5, step: 0.05, default: 0.9, advanced: true },
    { id: "top_k", label: "Top-k", type: "int", min: 1, max: 100, step: 1, default: 50, advanced: true },
  ],
  tags: [],
  max_chars_per_request: 400,
  supports_cancel: true,
  supports_seed: true,
  supports_reusable_prompt: true,
  watermark: null,
  post_processing: [],
  cancel_granularity: "segment",
};

export const CHATTERBOX_CAPS: Capabilities = {
  ...QWEN_CAPS,
  id: "chatterbox-turbo",
  name: "Chatterbox-Turbo",
  languages: [{ code: "en", label: "English", engine_value: "en" }],
  reference: { needs_transcript: false, min_seconds: 5, max_seconds: 30, recommended_seconds: [10, 15], sample_rate: 24000, channels: 1, notes: "" },
  controls: [{ id: "cfg_weight", label: "CFG weight", type: "float", min: 0, max: 1, step: 0.05, default: 0.5 }],
  supports_seed: false,
};

export function engines(opts: { chatterbox?: boolean; qwenInstalled?: boolean } = {}): EngineInfo[] {
  const list: EngineInfo[] = [
    { id: "qwen3-tts-base", name: "Qwen3-TTS 1.7B Base", installed: opts.qwenInstalled ?? true, state: "unloaded", model_state: "installed", optional: false, capabilities: QWEN_CAPS },
  ];
  if (opts.chatterbox) list.push({ id: "chatterbox-turbo", name: "Chatterbox-Turbo", installed: true, state: "unloaded", model_state: "installed", optional: true, capabilities: CHATTERBOX_CAPS });
  return list;
}

export function models(state: { tts?: ModelInfo["state"]; asr?: ModelInfo["state"] } = {}): ModelInfo[] {
  return [
    { id: "qwen3-tts-12hz-1.7b-base", engine_id: "qwen3-tts-base", kind: "tts", repo: "Qwen/Qwen3-TTS-12Hz-1.7B-Base", revision_pinned: "fd4b254389122332181a7c3db7f27e918eec64e3", approx_size_bytes: 4_540_000_000, license: "Apache-2.0", state: state.tts ?? "installed" },
    { id: "faster-whisper-small.en", engine_id: null, kind: "asr", repo: "Systran/faster-whisper-small.en", revision_pinned: null, approx_size_bytes: 490_000_000, license: "MIT", state: state.asr ?? "installed" },
  ];
}

export const SETTINGS = {
  offline: false,
  default_engine: "qwen3-tts-base",
  default_language: "en",
  asr_model: "faster-whisper-small.en",
  asr_device: "cpu",
  speak_autoplay: true,
  export_default_format: "wav",
  export_wav_bit_depth: 24,
  export_mp3_bitrate_kbps: 192,
  export_ai_metadata: true,
  export_loudness_target: null,
  onboarding_done: true,
  engine_settings: {},
  extra: {},
} as unknown as Settings;

export function voice(id: string, name: string, over: Partial<Voice> = {}): Voice {
  const refId = `ref_${id}`;
  return {
    id,
    name,
    tags: [],
    language: "en",
    rights_confirmed: true,
    favorite: false,
    archived: false,
    created_at: "2026-09-20T10:00:00Z",
    updated_at: "2026-09-20T10:00:00Z",
    selected_reference_id: refId,
    references: [
      {
        id: refId,
        voice_id: id,
        asset_id: `asset_${id}`,
        start_s: 1,
        end_s: 13,
        transcript: `Hello, this is ${name}.`,
        transcript_source: "asr",
        created_at: "2026-09-20T10:00:00Z",
        asset: { id: `asset_${id}`, kind: "reference", source: "recording", original_name: "a.wav", original_path: `/data/recordings/asset_${id}/original.wav`, working_path: `/data/recordings/asset_${id}/working.wav`, duration_s: 30, sample_rate: 48000, channels: 1, created_at: "2026-09-20T10:00:00Z" },
      },
    ],
    ...over,
  };
}

export const BOB = voice("v_bob", "Bob");
export const SARAH = voice("v_sarah", "Sarah");

export function session(over: Partial<SpeakSession> = {}): SpeakSession {
  return { project_id: "proj_speak", text: "", script_version: 0, voice_id: BOB.id, engine_id: "qwen3-tts-base", language: "en", settings: {}, history: [], ...over };
}

let n = 0;
export function entry(text: string, voiceName = "Bob", over: Partial<SpeechEntry> = {}): SpeechEntry {
  n += 1;
  return { id: `speech_${n}`, project_id: "proj_speak", text, voice_id: BOB.id, voice_name: voiceName, engine_id: "qwen3-tts-base", path: `/data/projects/proj_speak/history/speech_${n}.wav`, duration_s: 4.2, sample_rate: 24000, created_at: new Date().toISOString(), exists: true, ...over };
}

/** A promise the test resolves/rejects by hand, shaped like `api.request` results (it carries an `id`). */
export function pending<T>(id: string) {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  }) as Promise<T> & { id: string; cancel: () => Promise<void> };
  Object.defineProperty(p, "id", { value: id });
  Object.defineProperty(p, "cancel", { value: () => Promise.resolve(), configurable: true, writable: true });
  return { promise: p, resolve, reject };
}

/** Resolve like `api.request` does (with an id), so the store can cancel by id. */
export function resolved<T>(value: T, id = "req") {
  const p = Promise.resolve(value) as Promise<T> & { id: string; cancel: () => Promise<void> };
  Object.defineProperty(p, "id", { value: id });
  Object.defineProperty(p, "cancel", { value: () => Promise.resolve() });
  return p;
}
