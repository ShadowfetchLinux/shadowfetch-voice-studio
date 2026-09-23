/** The Voices screen: list, play sample, use, rename, add recording, edit sample, delete, empty state. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(async () => {
  const { createEventBus, makeApiModule } = await import("@/features/voices/testSupport");
  const bus = createEventBus();
  return { bus, mod: makeApiModule(bus) };
});
vi.mock("@/lib/api", async () => (await h).mod);

import App from "@/App";
import { useAppStore } from "@/store/appStore";
import { __resetVoicesStore } from "@/store/voicesStore";
import { __resetSpeakStore, useSpeakStore } from "@/features/speak/speakStore";
import { useCloneStore } from "@/features/voices/cloneStore";
import { BOB, SARAH, SETTINGS, engines, models, session, voice } from "@/features/speak/testing/fixtures";

const up = { running: true, restarts: 0, last_error: null, stopped: false };
let played = 0;

async function setup(voices = [BOB, SARAH]) {
  const { mod } = await h;
  mod.api.shell.workerStatus.mockResolvedValue(up);
  mod.api.system.settingsGet.mockResolvedValue(SETTINGS);
  mod.api.engine.list.mockResolvedValue({ engines: engines() });
  mod.api.models.list.mockResolvedValue({ models: models() });
  mod.api.voices.list.mockResolvedValue({ voices });
  mod.api.speak.session.mockResolvedValue(session());
  mod.api.projects.update.mockResolvedValue({});
  mod.api.audio.peaks.mockResolvedValue({ points: 2, duration_s: 30, sample_rate: 48000, peaks: [[-0.2, 0.2], [-0.2, 0.2]] });
  useAppStore.setState({ page: "voices" });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("heading", { name: "Voices" });
  return { mod, user };
}

beforeEach(async () => {
  const { bus } = await h;
  bus.clear();
  vi.clearAllMocks();
  __resetSpeakStore();
  __resetVoicesStore();
  useCloneStore.setState({ open: false });
  useAppStore.setState({ params: {}, booted: false, bootError: null, settings: null, workerStatus: null, engines: [], models: [] });
  played = 0;
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (this: HTMLMediaElement) {
    if (this.getAttribute("src")) setTimeout(() => this.dispatchEvent(new Event("loadedmetadata")), 0);
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    played += 1;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
});

function card(name: string) {
  return screen.getByRole("heading", { name }).closest("li") as HTMLElement;
}

describe("Voices screen", () => {
  it("lists voices with their name, sample length and date — no internal ids", async () => {
    await setup();
    await screen.findByRole("heading", { name: "Sarah" });
    expect(card("Bob")).toHaveTextContent("12 s sample");
    expect(card("Bob")).toHaveTextContent("Created Sep 20");
    expect(document.body.textContent).not.toMatch(/ref_|asset_|v_bob|cache/);
    expect(screen.getAllByRole("button", { name: "Clone Voice" }).length).toBeGreaterThan(0);
  });

  it("plays a voice's sample (only its selected part)", async () => {
    const { user } = await setup();
    await screen.findByRole("heading", { name: "Bob" });
    await user.click(within(card("Bob")).getByRole("button", { name: "Play Bob sample" }));
    await waitFor(() => expect(played).toBe(1));
    expect(within(card("Bob")).getByRole("button", { name: "Pause Bob sample" })).toBeInTheDocument();
  });

  it("Use Voice selects it for Speak and goes there", async () => {
    // the Speak screen has not loaded yet: choosing a voice must not be overwritten by the remembered one (regression)
    const { mod, user } = await setup();
    expect(useSpeakStore.getState().ready).toBe(false);
    await screen.findByRole("heading", { name: "Sarah" });
    await user.click(within(card("Sarah")).getByRole("button", { name: "Use Voice" }));
    await waitFor(() => expect(useAppStore.getState().page).toBe("speak"));
    await waitFor(() => expect(useSpeakStore.getState().voiceId).toBe(SARAH.id));
    expect(mod.api.projects.update).toHaveBeenCalledWith({ id: "proj_speak", patch: { voice_id: SARAH.id } });
    expect(await screen.findByRole("button", { name: /Voice: Sarah/ })).toBeInTheDocument();
  });

  it("renames a voice", async () => {
    const { mod, user } = await setup();
    await screen.findByRole("heading", { name: "Bob" });
    mod.api.voices.update.mockResolvedValue({ ...BOB, name: "Robert" });
    await user.click(within(card("Bob")).getByRole("button", { name: "More actions for Bob" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename voice" });
    const input = within(dialog).getByRole("textbox", { name: "Voice name" });
    await user.clear(input);
    await user.type(input, "Robert");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(mod.api.voices.update).toHaveBeenCalledWith({ id: BOB.id, patch: { name: "Robert" } }));
    expect(await screen.findByRole("heading", { name: "Robert" })).toBeInTheDocument();
  });

  it("deletes a voice after confirmation (projects keep their audio)", async () => {
    const { mod, user } = await setup();
    await screen.findByRole("heading", { name: "Bob" });
    await user.click(within(card("Bob")).getByRole("button", { name: "More actions for Bob" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Bob?" });
    expect(mod.api.voices.delete).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Delete Voice" }));
    await waitFor(() => expect(mod.api.voices.delete).toHaveBeenCalledWith({ id: BOB.id, force: true }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Bob" })).not.toBeInTheDocument());
  });

  it("Add Recording opens the clone flow for that voice", async () => {
    const { user } = await setup();
    await screen.findByRole("heading", { name: "Bob" });
    await user.click(within(card("Bob")).getByRole("button", { name: "More actions for Bob" }));
    await user.click(screen.getByRole("menuitem", { name: "Add Recording" }));
    expect(await screen.findByRole("dialog", { name: "Add a recording to Bob" })).toBeInTheDocument();
    expect(useCloneStore.getState().mode).toEqual({ kind: "addRecording", voiceId: BOB.id });
  });

  it("Edit Sample saves the new trim and words on the voice's recording", async () => {
    const { mod, user } = await setup();
    await screen.findByRole("heading", { name: "Bob" });
    mod.api.voices.updateReference.mockResolvedValue({});
    mod.api.voices.get.mockResolvedValue(BOB);
    await user.click(within(card("Bob")).getByRole("button", { name: "More actions for Bob" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit Sample" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Sample — Bob" });
    const words = within(dialog).getByRole("textbox", { name: "Words spoken in this part" });
    expect(words).toHaveValue("Hello, this is Bob.");
    await user.clear(words);
    await user.type(words, "Hello, this is Robert.");
    await user.click(within(dialog).getByRole("button", { name: "Save Sample" }));
    await waitFor(() =>
      expect(mod.api.voices.updateReference).toHaveBeenCalledWith({
        reference_id: BOB.selected_reference_id,
        patch: { trim: { start_s: 1, end_s: 13 }, transcript: "Hello, this is Robert.", transcript_source: "edited", transcript_confirmed: true, asr_model: null, processing: [] },
      }),
    );
    expect(mod.api.voices.selectReference).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("with several recordings, Edit Sample can switch the one the voice speaks with", async () => {
    const two = voice("v_two", "Duo");
    two.references = [...two.references!, { ...two.references![0]!, id: "ref_second", start_s: 2, end_s: 12 }];
    const { mod, user } = await setup([two]);
    await screen.findByRole("heading", { name: "Duo" });
    mod.api.voices.updateReference.mockResolvedValue({});
    mod.api.voices.get.mockResolvedValue(two);
    await user.click(within(card("Duo")).getByRole("button", { name: "More actions for Duo" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit Sample" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Sample — Duo" });
    await user.selectOptions(within(dialog).getByRole("combobox"), "ref_second");
    await user.click(await within(dialog).findByRole("button", { name: "Save and Use This Recording" }));
    await waitFor(() => expect(mod.api.voices.selectReference).toHaveBeenCalledWith({ voice_id: "v_two", reference_id: "ref_second" }));
  });

  it("empty state invites cloning the first voice", async () => {
    const { user } = await setup([]);
    expect(await screen.findByRole("heading", { name: "No voices yet" })).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "Clone Voice" });
    await user.click(buttons[buttons.length - 1]!);
    expect(await screen.findByRole("dialog", { name: "Clone a Voice" })).toBeInTheDocument();
  });
});
