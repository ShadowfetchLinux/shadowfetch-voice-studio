/**
 * Clone Voice end to end against a mocked worker: Record Voice / Use Audio File → automatic range selection and local
 * transcription → name + consent → voices.create → the new voice is selected on Speak. Problems in plain words,
 * manual Edit Sample, engines that need no transcript, and closing mid-operation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(async () => {
  const { createEventBus, makeApiModule } = await import("@/features/voices/testSupport");
  const bus = createEventBus();
  return { bus, mod: makeApiModule(bus) };
});
vi.mock("@/lib/api", async () => (await h).mod);

import App from "@/App";
import { useAppStore } from "@/store/appStore";
import { useModelSetup } from "@/store/modelSetup";
import { useModelOps } from "@/store/modelOps";
import { __resetVoicesStore, useVoicesStore } from "@/store/voicesStore";
import { __resetSpeakStore, useSpeakStore } from "@/features/speak/speakStore";
import { useCloneStore } from "@/features/voices/cloneStore";
import { workerFailure } from "@/features/voices/testSupport";
import { BOB, CHATTERBOX_CAPS, SETTINGS, engines, models, pending, resolved, session, voice } from "@/features/speak/testing/fixtures";
import type { EngineInfo, SuggestReferenceResult } from "@/lib/protocol";

const up = { running: true, restarts: 0, last_error: null, stopped: false };

function suggestion(over: Partial<SuggestReferenceResult> = {}): SuggestReferenceResult {
  return {
    start_s: 2.4,
    end_s: 14.1,
    duration_s: 11.7,
    reliable: true,
    edges_clean: true,
    speech_ratio: 0.88,
    speech_s: 28,
    total_s: 34,
    snr_db: 38,
    peak_dbfs: -5,
    issues: [],
    recommended_seconds: [8, 15],
    min_seconds: 3,
    max_seconds: 30,
    engine_id: "qwen3-tts-base",
    path: "/data/recordings/asset_new/working.wav",
    ...over,
  };
}

const importResult = {
  asset_id: "asset_new",
  original_path: "/data/recordings/asset_new/original.mp3",
  working_path: "/data/recordings/asset_new/working.wav",
  probe: { format: "mp3", codec: "mp3", duration_s: 34, sample_rate: 44100, channels: 2, size_bytes: 800_000 },
  peaks_path: "",
  stats: { duration_s: 34, sample_rate: 48000, channels: 1, peak_dbfs: -5, rms_dbfs: -20, clipping_samples: 0, leading_silence_s: 0.3, trailing_silence_s: 0.4, silence_ratio: 0.1, warnings: [] },
};

async function setup(opts: { engines?: EngineInfo[]; asr?: "installed" | "missing"; voices?: typeof BOB[] } = {}) {
  const { mod } = await h;
  mod.api.shell.workerStatus.mockResolvedValue(up);
  mod.api.system.settingsGet.mockResolvedValue(SETTINGS);
  mod.api.engine.list.mockResolvedValue({ engines: opts.engines ?? engines() });
  mod.api.models.list.mockResolvedValue({ models: models({ asr: opts.asr ?? "installed" }) });
  mod.api.voices.list.mockResolvedValue({ voices: opts.voices ?? [BOB] });
  mod.api.speak.session.mockResolvedValue(session());
  mod.api.projects.update.mockResolvedValue({});
  mod.api.record.devices.mockResolvedValue({ inputs: [{ index: 1, name: "USB Mic", hostapi: "ALSA", max_input_channels: 1, max_output_channels: 0, default_samplerate: 48000 }], default_input: 1 });
  mod.api.record.scripts.mockResolvedValue({ scripts: [{ id: "s1", title: "Read", style: "calm", text: "The rainbow is a division of white light.", approx_seconds: 25 }] });
  mod.api.record.start.mockResolvedValue({ session_id: "rec_9", path: "/x", negotiated: { sample_rate: 48000, channels: 1, dtype: "float32", subtype: "PCM_24", hostapi: "ALSA", device_name: "USB Mic", latency_s: 0.01 }, notes: [] });
  mod.api.record.stop.mockResolvedValue({ session_id: "rec_9", asset_id: "asset_rec", path: "/data/recordings/asset_rec/original.wav", working_path: "/data/recordings/asset_rec/working.wav", duration_s: 27.5, stats: null, negotiated: { sample_rate: 48000, channels: 1, dtype: "float32", subtype: "PCM_24", hostapi: "ALSA", device_name: "USB Mic", latency_s: 0.01 }, notes: [] });
  mod.api.audio.import.mockImplementation(() => resolved(importResult, "imp-1"));
  mod.api.audio.suggestReference.mockImplementation((p: { asset_id: string }) => resolved(suggestion({ path: `/data/recordings/${p.asset_id}/working.wav` }), "sug-1"));
  mod.api.transcribe.run.mockImplementation(() => resolved({ text: " The rainbow is a division of white light. ", language: "en", language_probability: 1, segments: [], confidence: 0.93, model_id: "faster-whisper-small.en", device: "cpu", duration_s: 11.7, elapsed_s: 2 }, "asr-1"));
  mod.api.audio.peaks.mockResolvedValue({ points: 4, duration_s: 34, sample_rate: 48000, peaks: [[-0.1, 0.1], [-0.4, 0.4], [-0.4, 0.4], [-0.1, 0.1]] });
  mod.api.shell.pickAudioFiles.mockResolvedValue(["/home/me/Morgan interview.mp3"]);
  mod.api.voices.create.mockImplementation((p: { name: string }) => Promise.resolve(voice("v_new", p.name)));
  mod.api.engine.prepareReference.mockResolvedValue({});
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("textbox", { name: "Text to speak" });
  await waitFor(() => expect(useAppStore.getState().models.length).toBeGreaterThan(0));
  await user.click(screen.getByRole("button", { name: "Clone Voice" }));
  const dialog = await screen.findByRole("dialog", { name: "Clone a Voice" });
  return { mod, user, dialog };
}

beforeEach(async () => {
  const { bus } = await h;
  bus.clear();
  vi.clearAllMocks();
  window.localStorage.clear();
  __resetSpeakStore();
  __resetVoicesStore();
  useModelSetup.setState({ open: false, resolve: null });
  useModelOps.setState({ downloads: {}, errors: {}, busy: {} });
  useCloneStore.setState({ open: false });
  useAppStore.setState({ page: "speak", params: {}, booted: false, bootError: null, settings: null, workerStatus: null, engines: [], models: [], engineStates: {}, modelStates: {} });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (this: HTMLMediaElement) {
    if (this.getAttribute("src")) setTimeout(() => this.dispatchEvent(new Event("loadedmetadata")), 0);
  });
});

async function nameAndCreate(user: ReturnType<typeof userEvent.setup>, name: string) {
  const ready = await screen.findByRole("dialog", { name: "Voice sample ready" });
  const create = within(ready).getByRole("button", { name: "Create Voice" });
  expect(create).toBeDisabled();
  const input = within(ready).getByRole("textbox", { name: "Voice Name" });
  await user.clear(input);
  await user.type(input, name);
  expect(create).toBeDisabled(); // consent first
  await user.click(within(ready).getByRole("checkbox", { name: /my voice, or I have permission/ }));
  await user.click(create);
}

describe("Clone Voice", () => {
  it("offers two plain choices", async () => {
    const { dialog } = await setup();
    expect(within(dialog).getByRole("button", { name: /Record Voice\s*Use your microphone\./ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Use Audio File\s*WAV, MP3, FLAC/ })).toBeInTheDocument();
  });

  it("records with the microphone, picks a clean part, transcribes it locally, creates the voice and selects it on Speak", async () => {
    const { bus, mod } = await h;
    const { user, dialog } = await setup();
    await user.click(within(dialog).getByRole("button", { name: /Record Voice/ }));
    expect(await screen.findByRole("dialog", { name: "Record Your Voice" })).toHaveTextContent("The rainbow is a division of white light.");
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await screen.findByRole("button", { name: "Stop recording" });
    act(() => bus.emit("record.level", { session_id: "rec_9", peak_dbfs: -8, rms_dbfs: -20, clipped: false, elapsed_s: 27.5, bytes_written: 1 }));
    await user.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => expect(mod.api.audio.suggestReference).toHaveBeenCalledWith({ asset_id: "asset_rec", engine_id: "qwen3-tts-base" }));
    // automatic transcription of exactly the suggested part (Qwen needs a transcript)
    await waitFor(() => expect(mod.api.transcribe.run).toHaveBeenCalledWith({ path: "/data/recordings/asset_rec/working.wav", start_s: 2.4, end_s: 14.1, model_id: "faster-whisper-small.en", device: "cpu", language: "en" }));
    const ready = await screen.findByRole("dialog", { name: "Voice sample ready" });
    expect(within(ready).getByRole("button", { name: "Play Sample" })).toBeInTheDocument();
    expect(ready).toHaveTextContent("12 seconds of clear speech");
    expect(within(ready).getByRole("button", { name: "Edit Sample" })).toBeInTheDocument();
    // no transcript screen and no technical words on the normal path
    expect(ready).not.toHaveTextContent(/transcri|reference|whisper|engine/i);

    await nameAndCreate(user, "Morgan");
    await waitFor(() =>
      expect(mod.api.voices.create).toHaveBeenCalledWith({
        name: "Morgan",
        tags: [],
        language: "en",
        rights_confirmed: true,
        asset_id: "asset_rec",
        trim: { start_s: 2.4, end_s: 14.1 },
        transcript: "The rainbow is a division of white light.",
        transcript_source: "asr",
        transcript_confirmed: false,
        asr_model: "faster-whisper-small.en",
        processing: [],
        engine_id: "qwen3-tts-base",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Voice created")).toBeInTheDocument();
    // persisted through the worker, selectable, and already selected
    expect(useVoicesStore.getState().voices.map((v) => v.name)).toContain("Morgan");
    expect(useSpeakStore.getState().voiceId).toBe("v_new");
    expect(mod.api.projects.update).toHaveBeenCalledWith({ id: "proj_speak", patch: { voice_id: "v_new" } });
    expect(screen.getByRole("button", { name: /Voice: Morgan/ })).toBeInTheDocument();
    // the first Speak is prepared in the background
    expect(mod.api.engine.prepareReference).toHaveBeenCalledWith({ engine_id: "qwen3-tts-base", reference_id: "ref_v_new" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Text to speak" })).toHaveFocus());
  });

  it("imports an audio file (picker), keeps the original, and creates the voice", async () => {
    const { mod } = await h;
    const { user, dialog } = await setup();
    await user.click(within(dialog).getByRole("button", { name: /Use Audio File/ }));
    await user.click(await screen.findByRole("button", { name: "Choose File…" }));
    expect(mod.api.audio.import).toHaveBeenCalledWith({ path: "/home/me/Morgan interview.mp3", kind: "reference" });
    await waitFor(() => expect(mod.api.transcribe.run).toHaveBeenCalled());
    const ready = await screen.findByRole("dialog", { name: "Voice sample ready" });
    expect(within(ready).getByRole("textbox", { name: "Voice Name" })).toHaveValue("Morgan interview");
    await nameAndCreate(user, "Morgan");
    await waitFor(() => expect(mod.api.voices.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Morgan", asset_id: "asset_new", trim: { start_s: 2.4, end_s: 14.1 } })));
  });

  it("imports a dropped file and ignores files that are not audio", async () => {
    const { mod } = await h;
    let drop: (paths: string[]) => void = () => {};
    mod.api.events.onFileDrop.mockImplementation((cb: (p: string[]) => void) => {
      drop = cb;
      return () => {};
    });
    const { user, dialog } = await setup();
    await user.click(within(dialog).getByRole("button", { name: /Use Audio File/ }));
    await screen.findByText("Drop an audio file here");
    act(() => drop(["/home/me/notes.pdf"]));
    expect(await screen.findByRole("alert")).toHaveTextContent("That isn't an audio file Voice Studio can open.");
    expect(mod.api.audio.import).not.toHaveBeenCalled();
    act(() => drop(["/home/me/voice.ogg"]));
    await waitFor(() => expect(mod.api.audio.import).toHaveBeenCalledWith({ path: "/home/me/voice.ogg", kind: "reference" }));
  });

  it("explains a corrupt file in plain words and lets the user choose another", async () => {
    const { mod } = await h;
    const { user, dialog } = await setup();
    mod.api.audio.import.mockImplementation(() => Promise.reject(workerFailure("CORRUPT_FILE", "Cannot decode x.mp3: Invalid data found when processing input")));
    await user.click(within(dialog).getByRole("button", { name: /Use Audio File/ }));
    await user.click(await screen.findByRole("button", { name: "Choose File…" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The audio file seems to be damaged or incomplete. Try another file.");
    expect(alert).not.toHaveTextContent("Invalid data");
    expect(screen.getByRole("button", { name: "Choose File…" })).toBeEnabled();
  });

  it("names the problems of a weak sample and offers Try Anyway / Choose Another File / Edit Sample", async () => {
    const { mod } = await h;
    const { user, dialog } = await setup();
    mod.api.audio.suggestReference.mockImplementation(() =>
      resolved(suggestion({ issues: [{ code: "TOO_QUIET", message: "peak -34 dBFS", severity: "warn", heuristic: true }, { code: "NOISY", message: "snr 9 dB", severity: "warn", heuristic: true }] })),
    );
    await user.click(within(dialog).getByRole("button", { name: /Use Audio File/ }));
    await user.click(await screen.findByRole("button", { name: "Choose File…" }));
    const problem = await screen.findByRole("dialog", { name: "This sample may not clone well" });
    expect(problem).toHaveTextContent("The recording is very quiet. Move closer to the microphone or choose another sample.");
    expect(problem).toHaveTextContent("The voice is difficult to hear over the background noise.");
    expect(problem).toHaveTextContent("Try another recording for better cloning");
    expect(problem).not.toHaveTextContent(/TOO_QUIET|NOISY|dBFS/);
    expect(within(problem).getByRole("button", { name: "Choose Another File" })).toBeInTheDocument();
    expect(within(problem).getByRole("button", { name: "Edit Sample" })).toBeInTheDocument();
    await user.click(within(problem).getByRole("button", { name: "Try Anyway" }));
    expect(await screen.findByRole("dialog", { name: "Voice sample ready" })).toBeInTheDocument();
  });

  it("refuses a sample without speech and does not transcribe it", async () => {
    const { mod } = await h;
    const { user, dialog } = await setup();
    mod.api.audio.suggestReference.mockImplementation(() => resolved(suggestion({ reliable: false, issues: [{ code: "NO_SPEECH", message: "x", severity: "block", heuristic: true }] })));
    await user.click(within(dialog).getByRole("button", { name: /Use Audio File/ }));
    await user.click(await screen.findByRole("button", { name: "Choose File…" }));
    const problem = await screen.findByRole("dialog", { name: "This sample can't be used" });
    expect(problem).toHaveTextContent("Very little speech was detected in this recording.");
    expect(within(problem).queryByRole("button", { name: "Try Anyway" })).not.toBeInTheDocument();
    expect(mod.api.transcribe.run).not.toHaveBeenCalled();
    await user.click(within(problem).getByRole("button", { name: "Choose Another File" }));
    expect(await screen.findByText("Drop an audio file here")).toBeInTheDocument();
  });

  it("falls back to the trim editor when no clean part is found; the words are filled in for the chosen part", async () => {
    const { mod } = await h;
    const { user, dialog } = await setup();
    mod.api.audio.suggestReference.mockImplementation(() => resolved(suggestion({ reliable: false, edges_clean: false, start_s: 0, end_s: 7 })));
    await user.click(within(dialog).getByRole("button", { name: /Use Audio File/ }));
    await user.click(await screen.findByRole("button", { name: "Choose File…" }));
    const edit = await screen.findByRole("dialog", { name: "Edit Sample" });
    expect(edit).toHaveTextContent("Choose the part to clone from — about 8–15 seconds of clear speech");
    expect(mod.api.transcribe.run).not.toHaveBeenCalled();
    expect(within(edit).getByTestId("trim-verdict")).toHaveTextContent("7.0 seconds selected. That works; 8–15 seconds of clear speech clones best.");
    await user.click(within(edit).getByRole("button", { name: "Use This Sample" }));
    await waitFor(() => expect(mod.api.transcribe.run).toHaveBeenCalledWith(expect.objectContaining({ start_s: 0, end_s: 7 })));
    const ready = await screen.findByRole("dialog", { name: "Voice sample ready" });
    await nameAndCreate(user, "Hand picked");
    // the words were filled in while submitting and never shown: saved as not reviewed by a person (review fix)
    await waitFor(() => expect(mod.api.voices.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Hand picked", trim: { start_s: 0, end_s: 7 }, transcript_confirmed: false })));
    expect(ready).toBeTruthy();
  });

  it("Cancel in Edit Sample opened from the ready step goes back to it with the sample kept (review fix)", async () => {
    const { mod } = await h;
    const { user, dialog } = await setup();
    await user.click(within(dialog).getByRole("button", { name: /Use Audio File/ }));
    await user.click(await screen.findByRole("button", { name: "Choose File…" }));
    const ready = await screen.findByRole("dialog", { name: "Voice sample ready" });
    await user.click(within(ready).getByRole("button", { name: "Edit Sample" }));
    const edit = await screen.findByRole("dialog", { name: "Edit Sample" });
    await user.click(within(edit).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("dialog", { name: "Voice sample ready" })).toBeInTheDocument();
    expect(mod.api.audio.import).toHaveBeenCalledTimes(1);
  });

  it("cloning from the project editor stays there and gives the open project the new voice (review fix)", async () => {
    const { mod } = await h;
    const { user } = await setup();
    await user.keyboard("{Escape}");
    const { useCreateStore } = await import("@/features/create/createStore");
    useCreateStore.setState({ projectId: "proj_book" });
    mod.api.projects.update.mockResolvedValue({ id: "proj_book", voice_id: "v_new" });
    act(() => useCloneStore.getState().start({ kind: "new" }, "editor"));
    await user.click(await screen.findByRole("button", { name: /Use Audio File/ }));
    await user.click(await screen.findByRole("button", { name: "Choose File…" }));
    await nameAndCreate(user, "Narrator");
    await waitFor(() => expect(mod.api.projects.update).toHaveBeenCalledWith({ id: "proj_book", patch: { voice_id: "v_new", reference_id: null } }));
    expect(useSpeakStore.getState().voiceId).not.toBe("v_new");
    expect(mod.api.projects.update).not.toHaveBeenCalledWith({ id: "proj_speak", patch: { voice_id: "v_new" } });
    useCreateStore.setState({ projectId: null });
  });

  it("lets the user correct the words under Edit Sample", async () => {
    const { mod } = await h;
    const { user, dialog } = await setup();
    await user.click(within(dialog).getByRole("button", { name: /Use Audio File/ }));
    await user.click(await screen.findByRole("button", { name: "Choose File…" }));
    const ready = await screen.findByRole("dialog", { name: "Voice sample ready" });
    await user.click(within(ready).getByRole("button", { name: "Edit Sample" }));
    const edit = await screen.findByRole("dialog", { name: "Edit Sample" });
    const words = within(edit).getByRole("textbox", { name: "Words spoken in this part" });
    expect(words).toHaveValue("The rainbow is a division of white light.");
    await user.clear(words);
    await user.type(words, "The rainbow is a division of bright light.");
    await user.click(within(edit).getByRole("button", { name: "Use This Sample" }));
    await nameAndCreate(user, "Corrected");
    await waitFor(() => expect(mod.api.voices.create).toHaveBeenCalledWith(expect.objectContaining({ transcript: "The rainbow is a division of bright light.", transcript_source: "edited", transcript_confirmed: true })));
    expect(mod.api.transcribe.run).toHaveBeenCalledTimes(1);
  });

  it("keeps the words with every voice, even when the engine itself does not need them", async () => {
    const { mod } = await h;
    const chatterboxOnly: EngineInfo[] = [{ id: "chatterbox-turbo", name: "Chatterbox-Turbo", installed: true, state: "unloaded", model_state: "installed", optional: true, capabilities: CHATTERBOX_CAPS }];
    const { user, dialog } = await setup({ engines: chatterboxOnly });
    await user.click(within(dialog).getByRole("button", { name: /Use Audio File/ }));
    await user.click(await screen.findByRole("button", { name: "Choose File…" }));
    await screen.findByRole("dialog", { name: "Voice sample ready" });
    expect(mod.api.audio.suggestReference).toHaveBeenCalledWith({ asset_id: "asset_new", engine_id: "chatterbox-turbo" });
    expect(mod.api.transcribe.run).toHaveBeenCalledTimes(1);
    await nameAndCreate(user, "Turbo");
    await waitFor(() => expect(mod.api.voices.create).toHaveBeenCalledWith(expect.objectContaining({ engine_id: "chatterbox-turbo", transcript: "The rainbow is a division of white light." })));
  });

  it("asks for the speech-recognition model first when it is missing", async () => {
    const { mod } = await h;
    const { user, dialog } = await setup({ asr: "missing" });
    await user.click(within(dialog).getByRole("button", { name: /Use Audio File/ }));
    await user.click(await screen.findByRole("button", { name: "Choose File…" }));
    const setupDialog = await screen.findByRole("dialog", { name: "Voice Studio needs its local models" });
    expect(setupDialog).toHaveTextContent("Whisper small (English)");
    expect(setupDialog).toHaveTextContent("Speech recognition");
    expect(setupDialog).toHaveTextContent("License: MIT");
    await user.click(within(setupDialog).getByRole("button", { name: "Not now" }));
    const failed = await screen.findByRole("dialog", { name: "A local model is needed" });
    expect(failed).toHaveTextContent("speech-recognition model");
    expect(mod.api.transcribe.run).not.toHaveBeenCalled();
  });

  it("offers the voice model alongside speech recognition, and it can be left for later", async () => {
    const { mod } = await h;
    const { user, dialog } = await setup({ asr: "missing" });
    mod.api.models.list.mockResolvedValue({ models: models({ asr: "missing", tts: "missing" }) });
    await useAppStore.getState().loadModels();
    mod.api.models.download.mockImplementation(() => {
      mod.api.models.list.mockResolvedValue({ models: models({ asr: "installed", tts: "missing" }) });
      return Promise.resolve({ model_id: "faster-whisper-small.en", path: "/m", revision: "r", size_bytes: 490_000_000 });
    });
    await user.click(within(dialog).getByRole("button", { name: /Use Audio File/ }));
    await user.click(await screen.findByRole("button", { name: "Choose File…" }));
    const setupDialog = await screen.findByRole("dialog", { name: "Voice Studio needs its local models" });
    expect(within(setupDialog).getByRole("button", { name: /Download models \(4\.7 GiB\)/ })).toBeInTheDocument();
    await user.click(within(setupDialog).getByRole("checkbox", { name: /Download it now too/ }));
    await user.click(within(setupDialog).getByRole("button", { name: "Download model" }));
    expect(mod.api.models.download).toHaveBeenCalledTimes(1);
    expect(mod.api.models.download).toHaveBeenCalledWith("faster-whisper-small.en", expect.anything());
    await waitFor(() => expect(mod.api.transcribe.run).toHaveBeenCalled());
    expect(await screen.findByRole("dialog", { name: "Voice sample ready" })).toBeInTheDocument();
  });

  it("closing mid-analysis asks first, then cancels the running request", async () => {
    const { mod } = await h;
    const { user, dialog } = await setup();
    const asr = pending<unknown>("asr-77");
    mod.api.transcribe.run.mockImplementation(() => asr.promise);
    const cancel = vi.fn(() => {
      asr.reject(workerFailure("CANCELLED", "Cancelled"));
      return Promise.resolve();
    });
    Object.defineProperty(asr.promise, "cancel", { value: cancel });
    await user.click(within(dialog).getByRole("button", { name: /Use Audio File/ }));
    await user.click(await screen.findByRole("button", { name: "Choose File…" }));
    await screen.findByText("Listening to the words…");
    await user.keyboard("{Escape}");
    const confirm = await screen.findByRole("dialog", { name: "Stop cloning this voice?" });
    await user.click(within(confirm).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(cancel).toHaveBeenCalled();
    expect(mod.api.voices.create).not.toHaveBeenCalled();
  });

  it("a voice created while a Speak is running is selected as soon as that run ends", async () => {
    const { mod } = await h;
    const { user } = await setup();
    await user.keyboard("{Escape}");
    const gen = pending<unknown>("gen-1");
    mod.api.speak.remember.mockImplementation((p: { text: string }) => Promise.resolve({ id: "s1", project_id: "proj_speak", text: p.text, voice_id: BOB.id, voice_name: "Bob", engine_id: "qwen3-tts-base", path: "/h/s1.wav", duration_s: 1, sample_rate: 24000, created_at: "", exists: true, pruned: {} }));
    mod.api.tts.plan.mockImplementation(() => resolved({ segments: [{ index: 0, paragraph: 0, text: "x", normalized_text: "x", substitutions: [], char_count: 1 }], engine_id: "qwen3-tts-base", warnings: [] }));
    mod.api.tts.generate.mockImplementation(() => gen.promise);
    mod.api.tts.assemble.mockImplementation(() => resolved({ master_path: "/m.wav", duration_s: 1, sample_rate: 24000, segments_used: 1 }));
    await user.type(screen.getByRole("textbox", { name: "Text to speak" }), "Busy.");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(mod.api.tts.generate).toHaveBeenCalled());
    // create a voice meanwhile
    await user.click(screen.getByRole("button", { name: "Clone Voice" }));
    await user.click(await screen.findByRole("button", { name: /Use Audio File/ }));
    await user.click(await screen.findByRole("button", { name: "Choose File…" }));
    await nameAndCreate(user, "Morgan");
    await waitFor(() => expect(mod.api.voices.create).toHaveBeenCalled());
    expect(useSpeakStore.getState().voiceId).toBe(BOB.id); // the running job keeps its voice
    await act(async () => gen.resolve({ takes: [], skipped: [], elapsed_s: 1 }));
    await waitFor(() => expect(useSpeakStore.getState().voiceId).toBe("v_new"));
    expect(mod.api.speak.remember).toHaveBeenCalledWith(expect.objectContaining({ voice_id: BOB.id }));
  });

  it("adds a recording to an existing voice and makes it the one it speaks with", async () => {
    const { mod } = await h;
    const { user } = await setup();
    await user.keyboard("{Escape}");
    act(() => useCloneStore.getState().start({ kind: "addRecording", voiceId: BOB.id }));
    const dialog = await screen.findByRole("dialog", { name: "Add a recording to Bob" });
    mod.api.voices.addReference.mockResolvedValue({});
    mod.api.voices.get.mockResolvedValue(BOB);
    await user.click(within(dialog).getByRole("button", { name: /Use Audio File/ }));
    await user.click(await screen.findByRole("button", { name: "Choose File…" }));
    const ready = await screen.findByRole("dialog", { name: "Voice sample ready" });
    expect(ready).toHaveTextContent("Bob will speak with this new sample.");
    await user.click(within(ready).getByRole("button", { name: "Add Recording" }));
    await waitFor(() => expect(mod.api.voices.addReference).toHaveBeenCalledWith(expect.objectContaining({ voice_id: BOB.id, select: true, asset_id: "asset_new" })));
    expect(mod.api.voices.create).not.toHaveBeenCalled();
  });
});
