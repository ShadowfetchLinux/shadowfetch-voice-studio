import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Reference, Settings, Voice } from "@/lib/protocol";

const h = vi.hoisted(async () => {
  const { createEventBus, makeApiModule } = await import("@/features/voices/testSupport");
  const bus = createEventBus();
  return { bus, mod: makeApiModule(bus) };
});
vi.mock("@/lib/api", async () => (await h).mod);

import { VoiceDetail, referenceAudioPath } from "@/features/voices/VoiceDetail";
import { useAppStore } from "@/store/appStore";

const asset: NonNullable<Reference["asset"]> = { id: "a1", kind: "reference", source: "recording", original_name: "take1.wav", original_path: "/data/recordings/a1/original.wav", working_path: "/data/recordings/a1/working.wav", duration_s: 40, sample_rate: 48000, channels: 1, created_at: "2026-01-01T00:00:00Z" };
const ref = (over: Partial<Reference>): Reference => ({ id: "r1", voice_id: "v1", asset_id: "a1", label: "Clip A", start_s: 1, end_s: 13, transcript: "Old transcript.", transcript_source: "edited", created_at: "2026-01-01T00:00:00Z", asset, ...over });
const voice = (refs: Reference[]): Voice => ({ id: "v1", name: "Me", tags: [], language: "en", rights_confirmed: true, selected_reference_id: "r1", favorite: false, archived: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", references: refs });

describe("referenceAudioPath", () => {
  it("prefers the decoded working file, falls back to the original and is null without an asset", () => {
    expect(referenceAudioPath(ref({}))).toBe("/data/recordings/a1/working.wav");
    expect(referenceAudioPath(ref({ asset: { ...asset, working_path: null } }))).toBe("/data/recordings/a1/original.wav");
    expect(referenceAudioPath(ref({ asset: null }))).toBeNull();
    expect(referenceAudioPath(ref({ asset: undefined }))).toBeNull();
  });
});

describe("<VoiceDetail /> re-transcribe", () => {
  beforeEach(async () => {
    const { mod } = await h;
    vi.clearAllMocks();
    useAppStore.setState({ settings: { asr_model: "faster-whisper-small.en", asr_device: "cpu" } as Settings });
    mod.api.transcribe.run.mockResolvedValue({ text: " The quick brown fox. ", language: "en", language_probability: 0.98, segments: [], model_id: "faster-whisper-small.en", device: "cpu", duration_s: 12, elapsed_s: 1.2 });
  });

  it("transcribes the reference's working file over its trim and opens the editor with the result", async () => {
    const { mod } = await h;
    const user = userEvent.setup();
    render(<VoiceDetail voice={voice([ref({})])} onAddReference={() => {}} onChanged={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Re-transcribe" }));
    await waitFor(() => expect(mod.api.transcribe.run).toHaveBeenCalledWith({ path: "/data/recordings/a1/working.wav", start_s: 1, end_s: 13, model_id: "faster-whisper-small.en", device: "cpu", language: "en" }, expect.objectContaining({ onProgress: expect.any(Function) })));
    const dialog = await screen.findByRole("dialog", { name: "Edit reference transcript" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText("Transcript")).toHaveValue("The quick brown fox.");
  });

  it("hides the button and explains why when the asset is gone", () => {
    render(<VoiceDetail voice={voice([ref({ asset: null })])} onAddReference={() => {}} onChanged={() => {}} />);
    expect(screen.queryByRole("button", { name: "Re-transcribe" })).not.toBeInTheDocument();
    expect(screen.getByText(/Re-transcribe is unavailable/)).toBeInTheDocument();
  });
});
