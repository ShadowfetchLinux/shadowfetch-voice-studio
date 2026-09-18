import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RecordLevel } from "@/lib/protocol";

const h = vi.hoisted(async () => {
  const { createEventBus, makeApiModule } = await import("@/features/voices/testSupport");
  const bus = createEventBus();
  return { bus, mod: makeApiModule(bus) };
});
vi.mock("@/lib/api", async () => (await h).mod);

import { initialRecorderState, recorderReducer, type RecorderStartResult, type RecorderStopResult } from "@/features/voices/recorderMachine";
import { Recorder } from "@/features/voices/Recorder";
import { workerFailure } from "@/features/voices/testSupport";

const negotiated = { sample_rate: 48000, channels: 1, dtype: "float32", subtype: "PCM_24", hostapi: "ALSA", device_name: "USB Mic", latency_s: 0.012, backend: "sounddevice", precision_note: "File is 24-bit; the microphone's effective precision is not reported by the capture API." };
const startResult: RecorderStartResult = { session_id: "rec_1", path: "/data/recordings/rec_1/original.wav", negotiated, notes: ["File is 24-bit; the microphone's effective precision is not reported by the capture API."], monitoring: false, take_number: 1 };
const stopResult: RecorderStopResult = { session_id: "rec_1", asset_id: "rec_1", path: "/data/recordings/rec_1/original.wav", working_path: "/data/recordings/rec_1/working.wav", duration_s: 42.5, stats: { duration_s: 42.5, sample_rate: 48000, channels: 1, peak_dbfs: -4.2, rms_dbfs: -20, clipping_samples: 0, leading_silence_s: 0.4, trailing_silence_s: 0.2, silence_ratio: 0.1, warnings: [] }, negotiated, notes: [], take_number: 1 };
const level = (over: Partial<RecordLevel> = {}): RecordLevel => ({ session_id: "rec_1", peak_dbfs: -8, rms_dbfs: -22, clipped: false, elapsed_s: 3.2, bytes_written: 460800, ...over });

describe("recorderReducer", () => {
  it("walks start → recording → paused → recording → stopping → idle with a take", () => {
    let s = recorderReducer(initialRecorderState, { type: "start" });
    expect(s.phase).toBe("starting");
    s = recorderReducer(s, { type: "started", result: startResult });
    expect(s.phase).toBe("recording");
    expect(s.sessionId).toBe("rec_1");
    expect(s.negotiated?.sample_rate).toBe(48000);
    s = recorderReducer(s, { type: "level", data: level({ elapsed_s: 3.2, clipped: true }) });
    expect(s.elapsed_s).toBe(3.2);
    expect(s.clippedInSession).toBe(true);
    // a level for another session is ignored
    s = recorderReducer(s, { type: "level", data: level({ session_id: "other", elapsed_s: 99 }) });
    expect(s.elapsed_s).toBe(3.2);
    s = recorderReducer(s, { type: "pause" });
    expect(s.phase).toBe("paused");
    s = recorderReducer(s, { type: "paused" });
    s = recorderReducer(s, { type: "resume" });
    expect(s.phase).toBe("recording");
    s = recorderReducer(s, { type: "stop" });
    expect(s.phase).toBe("stopping");
    s = recorderReducer(s, { type: "stopped", result: stopResult });
    expect(s.phase).toBe("idle");
    expect(s.sessionId).toBeNull();
    expect(s.takes).toHaveLength(1);
    expect(s.takes[0]?.asset_id).toBe("rec_1");
    expect(s.takes[0]?.working_path).toBe("/data/recordings/rec_1/working.wav");
    expect(s.nextTakeNumber).toBe(2);
    expect(s.level).toBeNull();
  });

  it("rejects illegal transitions and keeps the session on a failed pause", () => {
    expect(recorderReducer(initialRecorderState, { type: "pause" })).toBe(initialRecorderState);
    expect(recorderReducer(initialRecorderState, { type: "stop" })).toBe(initialRecorderState);
    let s = recorderReducer(recorderReducer(initialRecorderState, { type: "start" }), { type: "started", result: startResult });
    s = recorderReducer(s, { type: "pause" });
    s = recorderReducer(s, { type: "failed", error: { code: "INVALID_PARAMS", message: "Cannot pause", recoverable: true, during: "pause" } });
    expect(s.phase).toBe("recording");
    expect(s.sessionId).toBe("rec_1");
    expect(s.error?.code).toBe("INVALID_PARAMS");
  });

  it("maps a failed start to a retryable error without a session", () => {
    let s = recorderReducer(initialRecorderState, { type: "start" });
    s = recorderReducer(s, { type: "failed", error: { code: "DEVICE_UNAVAILABLE", message: "Device busy", recoverable: true, during: "start" } });
    expect(s.phase).toBe("error");
    expect(s.sessionId).toBeNull();
    s = recorderReducer(s, { type: "clearError" });
    expect(s.phase).toBe("idle");
  });

  it("turns a worker session error into an error phase that can still be stopped", () => {
    let s = recorderReducer(recorderReducer(initialRecorderState, { type: "start" }), { type: "started", result: startResult });
    s = recorderReducer(s, { type: "sessionState", data: { session_id: "rec_1", state: "error", reason: "DISK_FULL: the disk filled up while recording" } });
    expect(s.phase).toBe("error");
    expect(s.error?.code).toBe("DISK_FULL");
    expect(s.sessionId).toBe("rec_1");
    s = recorderReducer(s, { type: "stop" });
    expect(s.phase).toBe("stopping");
  });

  it("reports an empty stop honestly instead of inventing a take", () => {
    let s = recorderReducer(recorderReducer(initialRecorderState, { type: "start" }), { type: "started", result: startResult });
    s = recorderReducer(s, { type: "stopped", result: { ...stopResult, asset_id: null, duration_s: 0, notes: ["No audio was written, so nothing was added to the library."] } });
    expect(s.takes).toHaveLength(0);
    expect(s.error?.code).toBe("EMPTY_AUDIO");
    expect(s.error?.message).toMatch(/No audio was written/);
  });
});

describe("<Recorder /> with a mocked worker", () => {
  beforeEach(async () => {
    const { bus, mod } = await h;
    bus.clear();
    vi.clearAllMocks();
    mod.api.record.devices.mockResolvedValue({ inputs: [{ index: 3, name: "USB Mic", hostapi: "ALSA", max_input_channels: 1, max_output_channels: 0, default_samplerate: 48000, backend: "sounddevice" }], default_input: 3, backend: "sounddevice", notes: [] });
    mod.api.record.scripts.mockResolvedValue({ scripts: [{ id: "conversational", title: "Everyday conversation", style: "conversational", text: "Okay, so here's what happened this morning.", approx_seconds: 55 }, { id: "calm_narration", title: "Calm narration", style: "calm_narration", text: "The river begins as a thin stream.", approx_seconds: 60 }] });
    mod.api.record.start.mockResolvedValue(startResult);
    mod.api.record.pause.mockResolvedValue({ session_id: "rec_1", state: "paused" });
    mod.api.record.resume.mockResolvedValue({ session_id: "rec_1", state: "recording" });
    mod.api.record.stop.mockResolvedValue(stopResult);
  });

  it("records a take: start → live meter → pause/resume → stop → take list → use take", async () => {
    const { bus, mod } = await h;
    const user = userEvent.setup();
    const onUseTake = vi.fn();
    const onActiveChange = vi.fn();
    function Host() {
      const [active, setActive] = useState<string | null>(null);
      return <Recorder onUseTake={(t) => { onUseTake(t); setActive(t.asset_id); }} activeAssetId={active} onActiveChange={onActiveChange} />;
    }
    render(<Host />);
    await waitFor(() => expect(screen.getByText("Everyday conversation")).toBeInTheDocument());
    expect(screen.getByText(/Okay, so here's what happened/)).toBeInTheDocument();
    expect(screen.getByText(/monitoring \(hearing yourself\) is off/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(screen.getByTestId("recorder-state")).toHaveTextContent("Recording"));
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
    expect(mod.api.record.start).toHaveBeenCalledWith(expect.objectContaining({ device_index: null, channels: 1, script_id: "conversational", take_number: 1 }));
    expect(screen.getByText("24-bit file — device precision not reported")).toBeInTheDocument();
    expect(screen.getByText("USB Mic")).toBeInTheDocument();
    expect(screen.getByText("off (not implemented)")).toBeInTheDocument();

    act(() => bus.emit("record.level", level({ elapsed_s: 12.34, peak_dbfs: -6.5, clipped: true })));
    expect(screen.getByTestId("recorder-elapsed")).toHaveTextContent("0:12.3");
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "-6.5 dBFS");
    expect(screen.getByRole("button", { name: "CLIP" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Clipping was detected/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(screen.getByTestId("recorder-state")).toHaveTextContent("Paused"));
    expect(mod.api.record.pause).toHaveBeenCalledWith("rec_1");
    await user.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(screen.getByTestId("recorder-state")).toHaveTextContent("Recording"));

    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(screen.getByText("Take 1")).toBeInTheDocument());
    expect(mod.api.record.stop).toHaveBeenCalledWith("rec_1");
    expect(screen.getByTestId("recorder-state")).toHaveTextContent("Ready");
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByText(/43 s · 48000 Hz · peak -4.2 dBFS/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Use this take" }));
    expect(onUseTake).toHaveBeenCalledWith(expect.objectContaining({ asset_id: "rec_1", working_path: "/data/recordings/rec_1/working.wav", duration_s: 42.5 }));
    expect(screen.getByRole("button", { name: "Selected" })).toBeInTheDocument();
  });

  it("shows DEVICE_UNAVAILABLE from record.start with a working Retry", async () => {
    const { mod } = await h;
    const user = userEvent.setup();
    mod.api.record.start.mockRejectedValueOnce(workerFailure("DEVICE_UNAVAILABLE", "Could not open the input device (busy)."));
    render(<Recorder onUseTake={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Record" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Audio device unavailable");
    expect(alert).toHaveTextContent("Could not open the input device (busy).");
    expect(screen.getByTestId("recorder-state")).toHaveTextContent("Error");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mod.api.record.start).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("recorder-state")).toHaveTextContent("Recording"));
  });

  it("offers to keep the captured audio when the worker reports DISK_FULL mid-session", async () => {
    const { bus, mod } = await h;
    const user = userEvent.setup();
    render(<Recorder onUseTake={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(screen.getByTestId("recorder-state")).toHaveTextContent("Recording"));
    act(() => bus.emit("record.state", { session_id: "rec_1", state: "error", reason: "DISK_FULL: the disk filled up while recording; the audio captured so far was kept." }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Disk full");
    await user.click(screen.getByRole("button", { name: "Keep what was captured" }));
    await waitFor(() => expect(mod.api.record.stop).toHaveBeenCalledWith("rec_1"));
    await waitFor(() => expect(screen.getByText("Take 1")).toBeInTheDocument());
  });
});
