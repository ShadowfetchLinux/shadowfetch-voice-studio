import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { Settings, WorkerStatus } from "@/lib/protocol";

const h = vi.hoisted(async () => {
  const { createEventBus, makeApiModule } = await import("@/features/voices/testSupport");
  const bus = createEventBus();
  return { bus, mod: makeApiModule(bus) };
});
vi.mock("@/lib/api", async () => (await h).mod);

import App from "@/App";
import { useAppStore } from "@/store/appStore";

const up: WorkerStatus = { running: true, restarts: 0, last_error: null, stopped: false };
const starting: WorkerStatus = { running: false, restarts: 0, last_error: null, stopped: false };
const settings = { onboarding_done: true, default_engine: "qwen3-tts-base", default_language: "en" } as Settings;

/** The `worker://status` handlers App subscribed with (captured from the mocked `events.onWorkerStatus`). */
function statusHandlers(): Array<(s: WorkerStatus) => void> {
  return statusSubs;
}
let statusSubs: Array<(s: WorkerStatus) => void> = [];

describe("app boot waits for the worker", () => {
  beforeEach(async () => {
    const { mod } = await h;
    vi.clearAllMocks();
    statusSubs = [];
    mod.api.events.onWorkerStatus.mockImplementation((cb: (s: WorkerStatus) => void) => {
      statusSubs.push(cb);
      return () => {
        statusSubs = statusSubs.filter((x) => x !== cb);
      };
    });
    mod.api.system.settingsGet.mockResolvedValue(settings);
    mod.api.system.diagnostics.mockResolvedValue(null);
    mod.api.engine.list.mockResolvedValue({ engines: [] });
    mod.api.models.list.mockResolvedValue({ models: [] });
    useAppStore.setState({ page: "home", params: {}, booted: false, bootError: null, settings: null, workerStatus: null, diagnostics: null, engines: [], models: [] });
  });

  it("boots at once when the supervisor already reports the worker running", async () => {
    const { mod } = await h;
    mod.api.shell.workerStatus.mockResolvedValue(up);
    render(<App />);
    await waitFor(() => expect(useAppStore.getState().booted).toBe(true));
    expect(mod.api.system.settingsGet).toHaveBeenCalledTimes(1);
    expect(mod.api.engine.list).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().bootError).toBeNull();
  });

  it("sends no worker request until worker://status reports running=true, then boots", async () => {
    const { mod } = await h;
    mod.api.shell.workerStatus.mockResolvedValue(starting);
    render(<App />);
    // subscribed before the first boot, and the first boot only asked the shell for the status
    expect(statusHandlers()).toHaveLength(1);
    await waitFor(() => expect(mod.api.shell.workerStatus).toHaveBeenCalled());
    expect(await screen.findByText("Starting local worker…")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(mod.api.system.settingsGet).not.toHaveBeenCalled();
    expect(mod.api.engine.list).not.toHaveBeenCalled();
    expect(mod.api.system.diagnostics).not.toHaveBeenCalled();
    expect(useAppStore.getState().booted).toBe(false);
    expect(useAppStore.getState().bootError).toBeNull();

    mod.api.shell.workerStatus.mockResolvedValue(up);
    act(() => statusHandlers().forEach((cb) => cb(up)));
    await waitFor(() => expect(useAppStore.getState().booted).toBe(true));
    expect(mod.api.system.settingsGet).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mod.api.engine.list).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Starting local worker…")).not.toBeInTheDocument();
  });

  it("re-runs the boot when the worker comes back after a restart", async () => {
    const { mod } = await h;
    mod.api.shell.workerStatus.mockResolvedValue(up);
    render(<App />);
    await waitFor(() => expect(useAppStore.getState().booted).toBe(true));
    expect(mod.api.system.settingsGet).toHaveBeenCalledTimes(1);

    act(() => statusHandlers().forEach((cb) => cb({ ...starting, restarts: 1 })));
    expect(useAppStore.getState().workerStatus?.running).toBe(false);
    act(() => statusHandlers().forEach((cb) => cb({ ...up, restarts: 1 })));
    await waitFor(() => expect(mod.api.system.settingsGet).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mod.api.engine.list).toHaveBeenCalledTimes(2));
    // a running→running status update (e.g. the pending counter) does not boot again
    act(() => statusHandlers().forEach((cb) => cb({ ...up, restarts: 1, pending: 1 })));
    await new Promise((r) => setTimeout(r, 20));
    expect(mod.api.system.settingsGet).toHaveBeenCalledTimes(2);
  });

  it("does not get stuck when the running event overtakes a stale not-running snapshot", async () => {
    const { mod } = await h;
    let resolveSnapshot: (s: WorkerStatus) => void = () => {};
    mod.api.shell.workerStatus.mockImplementation(() => new Promise<WorkerStatus>((r) => (resolveSnapshot = r)));
    render(<App />);
    await waitFor(() => expect(mod.api.shell.workerStatus).toHaveBeenCalled());
    // the supervisor reports the worker up while the snapshot request is still pending, then the old snapshot lands
    act(() => statusHandlers().forEach((cb) => cb(up)));
    await act(async () => {
      resolveSnapshot(starting);
      await Promise.resolve();
    });
    await waitFor(() => expect(useAppStore.getState().booted).toBe(true));
    expect(mod.api.system.settingsGet).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().workerStatus?.running).toBe(true);
  });

  it("shows the supervisor's error with a restart action when it gave up", async () => {
    const { mod } = await h;
    mod.api.shell.workerStatus.mockResolvedValue({ running: false, restarts: 3, last_error: "python not found", stopped: true });
    render(<App />);
    expect(await screen.findByText("python not found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart worker" })).toBeInTheDocument();
    expect(mod.api.system.settingsGet).not.toHaveBeenCalled();
  });
});
