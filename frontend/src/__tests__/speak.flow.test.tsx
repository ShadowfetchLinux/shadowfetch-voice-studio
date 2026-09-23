/**
 * The Speak screen end to end against a mocked worker: launch → voice → text → Ctrl+Enter → plan → generate →
 * assemble → keep → auto-play → Save Audio; cancellation, repeated presses, voice changes, errors, model setup,
 * offline mode and text restoration.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { __resetVoicesStore } from "@/store/voicesStore";
import { __resetSpeakStore, DRAFT_KEY, useSpeakStore } from "@/features/speak/speakStore";
import { useCloneStore } from "@/features/voices/cloneStore";
import { workerFailure } from "@/features/voices/testSupport";
import { BOB, SARAH, SETTINGS, engines, entry, models, pending, resolved, session } from "@/features/speak/testing/fixtures";
import type { Settings } from "@/lib/protocol";

const up = { running: true, restarts: 0, last_error: null, stopped: false };
let played: HTMLMediaElement[] = [];

async function setup(opts: { settings?: Partial<Settings>; tts?: "installed" | "missing"; text?: string; voices?: typeof BOB[]; history?: ReturnType<typeof entry>[]; voiceId?: string | null } = {}) {
  const { mod } = await h;
  mod.api.shell.workerStatus.mockResolvedValue(up);
  mod.api.system.settingsGet.mockResolvedValue({ ...SETTINGS, ...opts.settings });
  mod.api.engine.list.mockResolvedValue({ engines: engines() });
  mod.api.models.list.mockResolvedValue({ models: models({ tts: opts.tts ?? "installed" }) });
  mod.api.voices.list.mockResolvedValue({ voices: opts.voices ?? [BOB, SARAH] });
  mod.api.speak.session.mockResolvedValue(session({ text: opts.text ?? "", history: opts.history ?? [], voice_id: opts.voiceId === undefined ? BOB.id : opts.voiceId }));
  mod.api.projects.update.mockResolvedValue({});
  mod.api.projects.saveScript.mockResolvedValue({ script_version: 2 });
  mod.api.tts.plan.mockImplementation(() => resolved({ segments: [{ index: 0, paragraph: 0, text: "x", normalized_text: "x", substitutions: [], char_count: 1 }], engine_id: "qwen3-tts-base", warnings: [] }, "plan-1"));
  mod.api.tts.generate.mockImplementation(() => resolved({ takes: [], skipped: [], elapsed_s: 1 }, "gen-1"));
  mod.api.tts.assemble.mockImplementation(() => resolved({ master_path: "/data/projects/proj_speak/master.wav", duration_s: 4.2, sample_rate: 24000, segments_used: 1 }, "asm-1"));
  mod.api.speak.remember.mockImplementation((p: { text: string }) => Promise.resolve({ ...entry(p.text), pruned: { takes_removed: 0, segments_removed: 0, history_removed: 0 } }));
  const user = userEvent.setup();
  render(<App />);
  const editor = await screen.findByRole("textbox", { name: "Text to speak" });
  await waitFor(() => expect(useAppStore.getState().engines.length).toBeGreaterThan(0));
  await waitFor(() => expect(useAppStore.getState().models.length).toBeGreaterThan(0));
  return { mod, user, editor };
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
  played = [];
  // jsdom never loads media: report metadata as soon as a source is set, and record play() calls
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (this: HTMLMediaElement) {
    if (this.getAttribute("src")) setTimeout(() => this.dispatchEvent(new Event("loadedmetadata")), 0);
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    played.push(this);
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
});

describe("Speak: launch, voice, text", () => {
  it("opens on Speak with the saved text, the remembered voice and the cursor in the editor", async () => {
    const { editor } = await setup({ text: "Saved from last time.", voiceId: SARAH.id });
    await waitFor(() => expect(editor).toHaveValue("Saved from last time."));
    expect(screen.getByRole("button", { name: "Voice: Sarah. Change voice" })).toBeInTheDocument();
    await waitFor(() => expect(editor).toHaveFocus());
    expect(screen.getByText("Ctrl")).toBeInTheDocument();
    expect(screen.getByText(/to speak/)).toBeInTheDocument();
  });

  it("picks another voice from the voice menu and remembers it on the scratch project", async () => {
    const { mod, user } = await setup();
    await user.click(screen.getByRole("button", { name: /Voice: Bob/ }));
    const menu = screen.getByRole("listbox", { name: "Voices" });
    expect(within(menu).getAllByRole("option").map((o) => o.textContent?.trim())).toEqual(["Bob", "Sarah", "Clone New Voice…", "Manage Voices"]);
    await user.click(within(menu).getByRole("option", { name: "Sarah" }));
    expect(screen.getByRole("button", { name: /Voice: Sarah/ })).toBeInTheDocument();
    expect(mod.api.projects.update).toHaveBeenCalledWith({ id: "proj_speak", patch: { voice_id: SARAH.id } });
    // no reference ids or engine internals anywhere on the screen
    expect(document.body.textContent).not.toMatch(/ref_|qwen|reference/i);
  });

  it("autosaves typed text to the scratch project (debounced) and mirrors it locally until saved", async () => {
    const { mod, user, editor } = await setup();
    await user.type(editor, "Hello there.");
    expect(JSON.parse(window.localStorage.getItem(DRAFT_KEY)!)).toMatchObject({ text: "Hello there.", saved: false });
    await waitFor(() => expect(mod.api.projects.saveScript).toHaveBeenCalledWith({ id: "proj_speak", text: "Hello there." }), { timeout: 2500 });
    expect(mod.api.projects.saveScript).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(DRAFT_KEY)!)).toMatchObject({ saved: true }));
  });

  it("restores an edit that never reached the worker after a restart, then saves it", async () => {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: "Typed just before closing.", projectId: "proj_speak", saved: false, at: Date.now() }));
    const { mod, editor } = await setup({ text: "Older saved text." });
    await waitFor(() => expect(editor).toHaveValue("Typed just before closing."));
    await waitFor(() => expect(mod.api.projects.saveScript).toHaveBeenCalledWith({ id: "proj_speak", text: "Typed just before closing." }), { timeout: 2500 });
  });

  it("keeps the text when navigating away and back", async () => {
    const { user, editor } = await setup();
    await user.type(editor, "Stay with me.");
    await user.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("button", { name: "Voices" }));
    await screen.findByRole("heading", { name: "Voices" });
    await user.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("button", { name: "Speak" }));
    expect(await screen.findByRole("textbox", { name: "Text to speak" })).toHaveValue("Stay with me.");
  });
});

describe("Speak: one button runs the whole pipeline", () => {
  it("Ctrl+Enter runs plan → generate (changed sentences only) → assemble → keep, then plays the result", async () => {
    const { mod, user, editor } = await setup();
    const gen = pending<unknown>("gen-1");
    let onProgress: ((p: unknown) => void) | undefined;
    mod.api.tts.generate.mockImplementation((_p: unknown, o?: { onProgress?: (p: unknown) => void }) => {
      onProgress = o?.onProgress;
      return gen.promise;
    });
    await user.type(editor, "Hello, this is Bob. And a second sentence. And a third.");
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => expect(mod.api.tts.generate).toHaveBeenCalled());
    expect(mod.api.tts.plan).toHaveBeenCalledWith(expect.objectContaining({ project_id: "proj_speak", script_text: "Hello, this is Bob. And a second sentence. And a third.", engine_id: "qwen3-tts-base" }));
    expect(mod.api.tts.generate.mock.calls[0]![0]).toMatchObject({
      project_id: "proj_speak",
      engine_id: "qwen3-tts-base",
      reference_id: BOB.selected_reference_id,
      language: "en",
      settings: { temperature: 0.9, top_k: 50 },
      only_changed: true,
    });
    expect(mod.api.tts.generate.mock.calls[0]![0]).not.toHaveProperty("regenerate_all");
    act(() => onProgress?.({ id: "gen-1", stage: "generate", message: "Generating segment 2 of 3", current: 2, total: 3 }));
    expect(screen.getByText("Generating speech — 2 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    await act(async () => gen.resolve({ takes: [], skipped: [], elapsed_s: 2 }));
    await waitFor(() => expect(mod.api.speak.remember).toHaveBeenCalled());
    const order = [mod.api.tts.plan, mod.api.tts.generate, mod.api.tts.assemble, mod.api.speak.remember].map((f) => f.mock.invocationCallOrder[0]!);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(mod.api.speak.remember).toHaveBeenCalledWith({ project_id: "proj_speak", text: "Hello, this is Bob. And a second sentence. And a third.", voice_id: BOB.id, keep: 30 });

    const player = await screen.findByRole("region", { name: "Generated speech" });
    expect(within(player).getByRole("button", { name: "Save Audio" })).toBeInTheDocument();
    await waitFor(() => expect(played.length).toBe(1));
    expect(played[0]!.getAttribute("src")).toMatch(/history\/speech_\d+\.wav$/);
    expect(screen.getByRole("button", { name: "Speak the text" })).toBeEnabled();
  });

  it("does not auto-play when auto-play is turned off", async () => {
    const { mod, user, editor } = await setup({ settings: { speak_autoplay: false } });
    await user.type(editor, "Quiet please.");
    await user.click(screen.getByRole("button", { name: "Speak the text" }));
    await waitFor(() => expect(mod.api.speak.remember).toHaveBeenCalled());
    await screen.findByRole("region", { name: "Generated speech" });
    await new Promise((r) => setTimeout(r, 30));
    expect(played).toHaveLength(0);
    // …but pressing play works
    await user.click(await screen.findByRole("button", { name: "Play" }));
    expect(played).toHaveLength(1);
  });

  it("ignores repeated Speak presses while a run is active", async () => {
    const { mod, user, editor } = await setup();
    const gen = pending<unknown>("gen-1");
    mod.api.tts.generate.mockImplementation(() => gen.promise);
    await user.type(editor, "Only once.");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.keyboard("{Control>}{Enter}{/Control}");
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(mod.api.tts.generate).toHaveBeenCalledTimes(1));
    expect(mod.api.tts.plan).toHaveBeenCalledTimes(1);
    await act(async () => gen.resolve({ takes: [], skipped: [], elapsed_s: 1 }));
    await waitFor(() => expect(mod.api.speak.remember).toHaveBeenCalledTimes(1));
  });

  it("says unchanged text again with a fresh reading, and a new voice regenerates with that voice", async () => {
    const { mod, user, editor } = await setup();
    await user.type(editor, "Say it again.");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(mod.api.speak.remember).toHaveBeenCalledTimes(1));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(mod.api.speak.remember).toHaveBeenCalledTimes(2));
    expect(mod.api.tts.generate.mock.calls[1]![0]).toMatchObject({ regenerate_all: true });
    expect(mod.api.tts.generate.mock.calls[1]![0]).not.toHaveProperty("only_changed");

    await user.click(screen.getByRole("button", { name: /Voice: Bob/ }));
    await user.click(screen.getByRole("option", { name: "Sarah" }));
    await user.click(screen.getByRole("button", { name: "Speak the text" }));
    await waitFor(() => expect(mod.api.speak.remember).toHaveBeenCalledTimes(3));
    expect(mod.api.tts.generate.mock.calls[2]![0]).toMatchObject({ reference_id: SARAH.selected_reference_id, only_changed: true });
    expect(mod.api.speak.remember.mock.calls[2]![0]).toMatchObject({ voice_id: SARAH.id });
  });

  it("keeps typing while speaking: the result is for the text that was spoken and the new text is saved after it", async () => {
    const { mod, user, editor } = await setup();
    const gen = pending<unknown>("gen-1");
    mod.api.tts.generate.mockImplementation(() => gen.promise);
    await user.type(editor, "First version.");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(mod.api.tts.generate).toHaveBeenCalled());
    await user.type(editor, " Plus more.");
    // the voice cannot change mid-run (the running job keeps the voice it started with)
    expect(screen.getByRole("button", { name: /Voice: Bob/ })).toBeDisabled();
    await act(async () => gen.resolve({ takes: [], skipped: [], elapsed_s: 1 }));
    await waitFor(() => expect(mod.api.speak.remember).toHaveBeenCalledWith(expect.objectContaining({ text: "First version." })));
    expect(editor).toHaveValue("First version. Plus more.");
    await waitFor(() => expect(mod.api.projects.saveScript).toHaveBeenLastCalledWith({ id: "proj_speak", text: "First version. Plus more." }), { timeout: 2500 });
  });

  it("Stop cancels through the worker, shows no error, and Speak works again", async () => {
    const { mod, user, editor } = await setup();
    const gen = pending<unknown>("gen-42");
    mod.api.tts.generate.mockImplementationOnce(() => gen.promise);
    mod.api.cancel.mockImplementation(async () => gen.reject(workerFailure("CANCELLED", "Cancelled", { completed: [{ segment_index: 0 }] })));
    await user.type(editor, "Long text to stop.");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    expect(mod.api.cancel).toHaveBeenCalledWith("gen-42");
    await waitFor(() => expect(screen.getByRole("button", { name: "Speak the text" })).toBeEnabled());
    expect(mod.api.tts.assemble).not.toHaveBeenCalled();
    expect(mod.api.speak.remember).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Esc also stops
    const gen2 = pending<unknown>("gen-43");
    mod.api.tts.generate.mockImplementationOnce(() => gen2.promise);
    mod.api.cancel.mockImplementation(async () => gen2.reject(workerFailure("CANCELLED", "Cancelled")));
    await user.click(screen.getByRole("button", { name: "Speak the text" }));
    await screen.findByRole("button", { name: "Stop" });
    await user.keyboard("{Escape}");
    expect(mod.api.cancel).toHaveBeenLastCalledWith("gen-43");
    await waitFor(() => expect(screen.getByRole("button", { name: "Speak the text" })).toBeEnabled());
  });
});

describe("Speak: results", () => {
  it("Save Audio exports the result's own file with the default format", async () => {
    const { mod, user, editor } = await setup();
    mod.api.shell.pickSavePath.mockResolvedValue("/home/me/hello.wav");
    mod.api.export.render.mockResolvedValue({ path: "/home/me/hello.wav", size_bytes: 1000, probe: {} });
    await user.type(editor, "Hello there, save me.");
    await user.click(screen.getByRole("button", { name: "Speak the text" }));
    const player = await screen.findByRole("region", { name: "Generated speech" });
    const kept = await mod.api.speak.remember.mock.results[0]!.value;
    await user.click(within(player).getByRole("button", { name: "Save Audio" }));
    expect(mod.api.shell.pickSavePath).toHaveBeenCalledWith("Hello there save me", "wav");
    await waitFor(() => expect(mod.api.export.render).toHaveBeenCalledWith({ project_id: "proj_speak", master_path: kept.path, format: "wav", out_path: "/home/me/hello.wav", wav_bit_depth: 24, ai_metadata: true }));
    expect(await screen.findByText("Audio saved")).toBeInTheDocument();

    await user.click(within(player).getByRole("button", { name: "Save as another format" }));
    await user.click(screen.getByRole("menuitem", { name: /Save as MP3/ }));
    expect(mod.api.shell.pickSavePath).toHaveBeenLastCalledWith("Hello there save me", "mp3");
    await waitFor(() => expect(mod.api.export.render).toHaveBeenLastCalledWith(expect.objectContaining({ format: "mp3", mp3_bitrate_kbps: 192 })));
  });

  it("plays an item from Recent", async () => {
    const older = entry("An older speech.");
    const newest = entry("The newest speech.");
    await setup({ history: [newest, older] });
    const user = userEvent.setup();
    const recent = await screen.findByRole("region", { name: "Recent" });
    await user.click(within(recent).getByRole("button", { name: /Play: An older speech/ }));
    await waitFor(() => expect(played.at(-1)?.getAttribute("src")).toContain(older.path));
    expect(useSpeakStore.getState().current?.id).toBe(older.id);
  });
});

describe("Speak: problems in plain language", () => {
  it("GPU_OOM shows what to do; the technical error is one click away", async () => {
    const { mod, user, editor } = await setup();
    mod.api.tts.generate.mockImplementation(() => Promise.reject(workerFailure("GPU_OOM", "CUDA out of memory. Tried to allocate 2.00 GiB", { completed: [] })));
    await user.type(editor, "Too big.");
    await user.click(screen.getByRole("button", { name: "Speak the text" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your GPU ran out of memory while generating this speech. Close other GPU-heavy applications and try again.");
    expect(alert).not.toHaveTextContent("CUDA");
    await user.click(within(alert).getByRole("button", { name: "Technical details" }));
    expect(alert).toHaveTextContent("GPU_OOM: CUDA out of memory");
    mod.api.tts.generate.mockImplementation(() => resolved({ takes: [], skipped: [], elapsed_s: 1 }, "gen-2"));
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mod.api.speak.remember).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("asks to clone a voice first when there is none", async () => {
    const { mod, user, editor } = await setup({ voices: [], voiceId: null });
    await user.type(editor, "Nobody to say this.");
    await user.click(screen.getByRole("button", { name: "Speak the text" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("First, clone a voice");
    expect(mod.api.tts.plan).not.toHaveBeenCalled();
    await user.click(within(alert).getByRole("button", { name: "Clone Voice" }));
    expect(await screen.findByRole("dialog", { name: "Clone a Voice" })).toBeInTheDocument();
  });

  it("offers the model download (size, source, license) when the voice model is missing, then speaks", async () => {
    const { mod, user, editor } = await setup({ tts: "missing" });
    mod.api.models.download.mockImplementation(() => {
      mod.api.models.list.mockResolvedValue({ models: models({ tts: "installed" }) });
      return Promise.resolve({ model_id: "qwen3-tts-12hz-1.7b-base", path: "/models/qwen", revision: "fd4b254389122332181a7c3db7f27e918eec64e3", size_bytes: 4_540_000_000 });
    });
    await user.type(editor, "First words.");
    await user.click(screen.getByRole("button", { name: "Speak the text" }));
    const dialog = await screen.findByRole("dialog", { name: "Voice Studio needs its local voice model" });
    expect(dialog).toHaveTextContent("Qwen3-TTS 1.7B");
    expect(dialog).toHaveTextContent("about 4.2 GiB");
    expect(dialog).toHaveTextContent("Runs locally on your NVIDIA GPU.");
    expect(dialog).toHaveTextContent("Source: Qwen/Qwen3-TTS-12Hz-1.7B-Base @ fd4b254389");
    expect(dialog).toHaveTextContent("License: Apache-2.0");
    expect(mod.api.models.download).not.toHaveBeenCalled();
    expect(mod.api.tts.plan).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Download model" }));
    expect(mod.api.models.download).toHaveBeenCalledWith("qwen3-tts-12hz-1.7b-base", expect.anything());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(mod.api.speak.remember).toHaveBeenCalled());
  });

  it("closing the model dialog cancels the Speak without a loop", async () => {
    const { mod, user, editor } = await setup({ tts: "missing" });
    await user.type(editor, "Not now.");
    await user.click(screen.getByRole("button", { name: "Speak the text" }));
    const dialog = await screen.findByRole("dialog", { name: "Voice Studio needs its local voice model" });
    await user.click(within(dialog).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Speak the text" })).toBeEnabled();
    expect(mod.api.tts.plan).not.toHaveBeenCalled();
  });

  it("in offline mode the dialog cannot download and says why", async () => {
    const { mod, user, editor } = await setup({ tts: "missing", settings: { offline: true } });
    await user.type(editor, "Offline.");
    await user.click(screen.getByRole("button", { name: "Speak the text" }));
    const dialog = await screen.findByRole("dialog", { name: "Voice Studio needs its local voice model" });
    expect(dialog).toHaveTextContent("Offline mode is on, so nothing can be downloaded.");
    expect(within(dialog).getByRole("button", { name: "Download model" })).toBeDisabled();
    expect(mod.api.models.download).not.toHaveBeenCalled();
  });

  it("MODEL_MISSING from the worker (lists not yet refreshed) offers the install", async () => {
    const { mod, user, editor } = await setup();
    mod.api.tts.generate.mockImplementationOnce(() => Promise.reject(workerFailure("MODEL_MISSING", "The model qwen3-tts-12hz-1.7b-base is not installed")));
    mod.api.models.list.mockResolvedValue({ models: models({ tts: "missing" }) });
    await user.type(editor, "Hi.");
    await user.click(screen.getByRole("button", { name: "Speak the text" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The local voice model needs to be installed before Voice Studio can speak.");
    await user.click(within(alert).getByRole("button", { name: "Install the voice model" }));
    expect(await screen.findByRole("dialog", { name: "Voice Studio needs its local voice model" })).toBeInTheDocument();
  });
});

describe("Speak: review fixes", () => {
  it("pressing Speak before the engine list arrived waits for it and sends the engine's own settings", async () => {
    const { mod, user, editor } = await setup();
    useAppStore.setState({ engines: [], models: [] });
    await user.type(editor, "Early bird.");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(mod.api.tts.generate).toHaveBeenCalled());
    expect(mod.api.tts.generate.mock.calls[0]![0]).toMatchObject({ settings: { temperature: 0.9, top_k: 50 } });
  });

  it("a result that finishes while the user is on another screen does not start playing later", async () => {
    const { mod, user, editor } = await setup();
    const gen = pending<unknown>("gen-1");
    mod.api.tts.generate.mockImplementation(() => gen.promise);
    await user.type(editor, "Play me later.");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(mod.api.tts.generate).toHaveBeenCalled());
    await user.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("button", { name: "Voices" }));
    await act(async () => gen.resolve({ takes: [], skipped: [], elapsed_s: 1 }));
    await waitFor(() => expect(mod.api.speak.remember).toHaveBeenCalled());
    await user.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("button", { name: "Speak" }));
    await screen.findByRole("region", { name: "Generated speech" });
    await new Promise((r) => setTimeout(r, 30));
    expect(played).toHaveLength(0);
  });

  it("keyboard focus moves to Stop while speaking and back to Speak afterwards", async () => {
    const { mod, user, editor } = await setup();
    const gen = pending<unknown>("gen-1");
    mod.api.tts.generate.mockImplementation(() => gen.promise);
    await user.type(editor, "Focus.");
    await user.click(screen.getByRole("button", { name: "Speak the text" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus());
    await act(async () => gen.resolve({ takes: [], skipped: [], elapsed_s: 1 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Speak the text" })).toHaveFocus());
  });

  it("Stop during the last step keeps the result without playing it", async () => {
    const { mod, user, editor } = await setup();
    const remember = pending<unknown>("rem-1");
    mod.api.speak.remember.mockImplementation(() => remember.promise);
    await user.type(editor, "Almost done.");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(mod.api.speak.remember).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await act(async () => remember.resolve({ ...entry("Almost done."), pruned: {} }));
    await screen.findByRole("region", { name: "Generated speech" });
    await new Promise((r) => setTimeout(r, 30));
    expect(played).toHaveLength(0);
  });

  it("a stopped 'say it again' continues with the sentences it had not reached", async () => {
    const { mod, user, editor } = await setup();
    mod.api.tts.plan.mockImplementation(() =>
      resolved({ segments: [0, 1, 2, 3].map((i) => ({ index: i, paragraph: 0, text: `s${i}`, normalized_text: `s${i}`, substitutions: [], char_count: 2 })), engine_id: "qwen3-tts-base", warnings: [] }, "plan-1"),
    );
    await user.type(editor, "One. Two. Three. Four.");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(mod.api.speak.remember).toHaveBeenCalledTimes(1));
    // say it again → stopped after two sentences
    mod.api.tts.generate.mockImplementationOnce(() => Promise.reject(workerFailure("CANCELLED", "Cancelled", { completed: [{ segment_index: 0 }, { segment_index: 1 }] })));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(mod.api.tts.generate).toHaveBeenCalledTimes(2));
    expect(mod.api.tts.generate.mock.calls[1]![0]).toMatchObject({ regenerate_all: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Speak the text" })).toBeEnabled());
    // pressing Speak again continues with the rest only
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(mod.api.tts.generate).toHaveBeenCalledTimes(3));
    expect(mod.api.tts.generate.mock.calls[2]![0]).toMatchObject({ segment_indices: [2, 3] });
    expect(mod.api.tts.generate.mock.calls[2]![0]).not.toHaveProperty("regenerate_all");
  });

  it("the voice a running Speak uses cannot be deleted from Voices", async () => {
    const { mod, user, editor } = await setup();
    const gen = pending<unknown>("gen-1");
    mod.api.tts.generate.mockImplementation(() => gen.promise);
    await user.type(editor, "Busy voice.");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(mod.api.tts.generate).toHaveBeenCalled());
    await user.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("button", { name: "Voices" }));
    await user.click(await screen.findByRole("button", { name: "More actions for Bob" }));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "More actions for Sarah" }));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeEnabled();
    await act(async () => gen.resolve({ takes: [], skipped: [], elapsed_s: 1 }));
  });

  it("a failed startup load offers Try again and recovers", async () => {
    const { mod } = await h;
    mod.api.speak.session.mockRejectedValueOnce(workerFailure("DB_ERROR", "database is locked"));
    mod.api.shell.workerStatus.mockResolvedValue(up);
    mod.api.system.settingsGet.mockResolvedValue(SETTINGS);
    mod.api.engine.list.mockResolvedValue({ engines: engines() });
    mod.api.models.list.mockResolvedValue({ models: models() });
    mod.api.voices.list.mockResolvedValue({ voices: [BOB] });
    const user = userEvent.setup();
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("couldn't be loaded");
    mod.api.speak.session.mockResolvedValue(session({ text: "Back again." }));
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Text to speak" })).toHaveValue("Back again."));
  });
});

