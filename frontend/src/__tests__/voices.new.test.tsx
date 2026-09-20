import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Voice } from "@/lib/protocol";

const h = vi.hoisted(async () => {
  const { createEventBus, makeApiModule } = await import("@/features/voices/testSupport");
  const bus = createEventBus();
  return { bus, mod: makeApiModule(bus) };
});
vi.mock("@/lib/api", async () => (await h).mod);

import VoicesPage from "@/pages/VoicesPage";
import { useAppStore } from "@/store/appStore";

const voice: Voice = {
  id: "v1",
  name: "Me",
  tags: [],
  language: "en",
  rights_confirmed: true,
  selected_reference_id: "r1",
  favorite: false,
  archived: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  references: [
    {
      id: "r1",
      voice_id: "v1",
      asset_id: "a1",
      label: "Clip A",
      start_s: 1,
      end_s: 13,
      transcript: "Hello",
      transcript_source: "edited",
      created_at: "2026-01-01T00:00:00Z",
    },
  ],
};

describe("New voice starts the create-voice flow", () => {
  beforeEach(async () => {
    const { mod } = await h;
    vi.clearAllMocks();
    mod.api.voices.list.mockResolvedValue({ voices: [] });
    mod.api.library.tags.mockResolvedValue({ tags: [] });
    mod.api.record.devices.mockResolvedValue({ inputs: [{ index: 0, name: "USB Mic", hostapi: "ALSA", max_input_channels: 1, default_samplerate: 48000 }], default_input: 0, backend: "sounddevice", notes: [] });
    mod.api.record.scripts.mockResolvedValue({ scripts: [{ id: "s1", title: "Warm-up", text: "Say this.", duration_hint_s: 15 }] });
    useAppStore.setState({ page: "voices", params: {}, settings: { default_engine: "qwen3-tts-base", default_language: "en" } as never });
  });

  it("opens the wizard on load and starts recording from the empty-state Record button", async () => {
    const user = userEvent.setup();
    render(<VoicesPage />);
    expect(await screen.findByRole("heading", { name: "New voice" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Record/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Input device")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Record" }));
    expect(await screen.findByLabelText("Input device")).toBeInTheDocument();
    expect(useAppStore.getState()).toMatchObject({ page: "voices", params: { action: "record" } });
  });

  it("starts import mode from the empty-state Import button", async () => {
    const user = userEvent.setup();
    render(<VoicesPage />);
    await screen.findByRole("heading", { name: "New voice" });
    await user.click(screen.getByRole("button", { name: "Import file" }));
    expect(await screen.findByRole("button", { name: "Choose audio files…" })).toBeInTheDocument();
    expect(useAppStore.getState().params.action).toBe("import");
  });

  it("treats action=new as starting the wizard (not a no-op) and remounts when New voice is clicked again", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ params: { action: "record" } });
    render(<VoicesPage />);
    expect(await screen.findByLabelText("Input device")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New voice" }));
    await waitFor(() => expect(useAppStore.getState().params.action).toBe("new"));
    expect(screen.queryByLabelText("Input device")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Record/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Import a file/ })).toBeInTheDocument();
  });

  it("leaves a selected voice and starts a fresh wizard when New voice is clicked", async () => {
    const { mod } = await h;
    const user = userEvent.setup();
    mod.api.voices.list.mockResolvedValue({ voices: [voice] });
    render(<VoicesPage />);
    await screen.findByRole("button", { name: /^Me/ });
    await user.click(screen.getByRole("button", { name: /^Me/ }));
    expect(await screen.findByRole("heading", { name: "Me" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "New voice" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New voice" }));
    expect(await screen.findByRole("heading", { name: "New voice" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Record/ })).toBeInTheDocument();
    expect(useAppStore.getState().params.action).toBe("new");
  });

  it("honours Home-style record/import route params on first paint", async () => {
    useAppStore.setState({ params: { action: "import" } });
    render(<VoicesPage />);
    expect(await screen.findByRole("button", { name: "Choose audio files…" })).toBeInTheDocument();
    expect(within(document.getElementById("new-voice-wizard")!).getByRole("radio", { name: /Import a file/ })).toHaveAttribute("aria-checked", "true");
  });
});
