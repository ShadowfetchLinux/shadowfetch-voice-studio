/** Settings: simple choices up front; Advanced renders only what the selected engine declares; offline mode. */
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
import { __resetSpeakStore } from "@/features/speak/speakStore";
import { BOB, SETTINGS, engines, models, session } from "@/features/speak/testing/fixtures";

const up = { running: true, restarts: 0, last_error: null, stopped: false };

async function setup(speakSettings: Record<string, unknown> = {}, settingsOver: Record<string, unknown> = {}) {
  const { mod } = await h;
  mod.api.shell.workerStatus.mockResolvedValue(up);
  mod.api.system.settingsGet.mockResolvedValue({ ...SETTINGS, ...settingsOver });
  mod.api.system.settingsSet.mockImplementation((patch: object) => Promise.resolve({ ...SETTINGS, ...settingsOver, ...patch }));
  mod.api.engine.list.mockResolvedValue({ engines: engines({ chatterbox: true }) });
  mod.api.models.list.mockResolvedValue({ models: models() });
  mod.api.voices.list.mockResolvedValue({ voices: [BOB] });
  mod.api.speak.session.mockResolvedValue(session({ settings: speakSettings }));
  mod.api.projects.update.mockResolvedValue({});
  mod.api.export.loudnessTargets.mockResolvedValue({ targets: [{ id: "podcast-16", label: "Podcast (-16 LUFS, -1 dBTP)", integrated_lufs: -16, true_peak_dbtp: -1, lra: 11, description: "" }] });
  mod.api.system.storageUsage.mockResolvedValue({ data_dir: "/data", models_bytes: 1, recordings_bytes: 1, projects_bytes: 1, cache_bytes: 1, free_bytes: 1 });
  useAppStore.setState({ page: "settings" });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("heading", { name: "Settings" });
  await waitFor(() => expect(useAppStore.getState().engines.length).toBe(2));
  return { mod, user };
}

beforeEach(async () => {
  const { bus } = await h;
  bus.clear();
  vi.clearAllMocks();
  __resetSpeakStore();
  __resetVoicesStore();
  useAppStore.setState({ params: {}, booted: false, bootError: null, settings: null, workerStatus: null, engines: [], models: [] });
});

describe("Settings", () => {
  it("shows only everyday choices until Advanced is opened", async () => {
    const { mod, user } = await setup();
    expect(screen.getByText("Play speech automatically")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Save Audio as" })).toBeInTheDocument();
    for (const word of ["Sampling temperature", "Top-k", "Seed", "Models & engines", "Pronunciation"]) expect(screen.queryByText(word)).not.toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: /Play speech automatically/ }));
    await waitFor(() => expect(mod.api.system.settingsSet).toHaveBeenCalledWith({ speak_autoplay: false }));
  });

  it("Advanced renders exactly the controls the selected engine declares and stores them on Speak", async () => {
    const { mod, user } = await setup();
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    const speech = (await screen.findByRole("heading", { name: "Speech generation" })).closest("section") as HTMLElement;
    await user.click(within(speech).getByRole("button", { name: /More engine settings/ }));
    expect(within(speech).getByText("Sampling temperature")).toBeInTheDocument();
    expect(within(speech).getByText("Top-k")).toBeInTheDocument();
    expect(within(speech).queryByText("CFG weight")).not.toBeInTheDocument();
    expect(within(speech).getByLabelText("Seed")).toBeInTheDocument();

    // switching the engine switches the declared controls (Chatterbox declares no seed and one control)
    await user.selectOptions(within(speech).getByRole("combobox", { name: "Engine" }), "chatterbox-turbo");
    await waitFor(() => expect(mod.api.projects.update).toHaveBeenCalledWith({ id: "proj_speak", patch: { settings: { speak: { engine_id: "chatterbox-turbo" } } } }));
  });

  it("Advanced follows an engine override stored on the Speak project", async () => {
    const { user } = await setup({ speak: { engine_id: "chatterbox-turbo" } });
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    const speech = (await screen.findByRole("heading", { name: "Speech generation" })).closest("section") as HTMLElement;
    await waitFor(() => expect(within(speech).getByText("CFG weight")).toBeInTheDocument());
    expect(within(speech).queryByText("Sampling temperature")).not.toBeInTheDocument();
    expect(within(speech).queryByLabelText("Seed")).not.toBeInTheDocument();
  });

  it("offline mode goes through the worker (which enforces it) and says what it means", async () => {
    const { mod, user } = await setup();
    mod.api.system.setOffline.mockResolvedValue({ offline: true });
    const privacy = screen.getByRole("heading", { name: "Privacy" }).closest("section") as HTMLElement;
    expect(privacy).toHaveTextContent("No accounts, no telemetry, no cloud");
    await user.click(within(privacy).getByRole("switch", { name: /Offline mode/ }));
    await waitFor(() => expect(mod.api.system.setOffline).toHaveBeenCalledWith(true));
    expect(await screen.findByText("Offline mode on")).toBeInTheDocument();
  });

  it("Save Audio details write the export preferences", async () => {
    const { mod, user } = await setup();
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    await user.selectOptions(await screen.findByRole("combobox", { name: "Loudness" }), "podcast-16");
    await waitFor(() => expect(mod.api.system.settingsSet).toHaveBeenCalledWith({ export_loudness_target: "podcast-16" }));
  });
});
