import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Diagnostics, Settings } from "@/lib/protocol";

const h = vi.hoisted(async () => {
  const { createEventBus, makeApiModule } = await import("@/features/voices/testSupport");
  const bus = createEventBus();
  return { bus, mod: makeApiModule(bus) };
});
vi.mock("@/lib/api", async () => (await h).mod);

import SetupPage from "@/pages/SetupPage";
import { useAppStore, useToastStore } from "@/store/appStore";

function diagnostics(envs: Diagnostics["python"]["engines"]): Diagnostics {
  return {
    os: { system: "Linux", release: "6.0", machine: "x86_64", pretty: "Linux" },
    cpu: { name: "cpu", threads: 8 },
    ram: { total_bytes: 32e9, available_bytes: 16e9 },
    gpus: [],
    disk: { path: "/data", free_bytes: 100e9, total_bytes: 500e9 },
    ffmpeg: { path: "/usr/bin/ffmpeg", version: "7.0" },
    ffprobe: { path: "/usr/bin/ffprobe", version: "7.0" },
    python: { main: { version: "3.12", path: "/py" }, engines: envs },
    audio: { inputs: [], outputs: [] },
    offline: false,
    data_dir: "/data",
    models_dir: "/data/models",
    warnings: [],
  };
}

describe("<SetupPage /> runtime bootstrap", () => {
  beforeEach(async () => {
    const { mod } = await h;
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] });
    mod.api.system.diagnostics.mockImplementation(() => Promise.resolve(useAppStore.getState().diagnostics));
    mod.api.engine.list.mockResolvedValue({ engines: [] });
    useAppStore.setState({
      settings: { onboarding_done: false, default_engine: "qwen3-tts-base", asr_model: "faster-whisper-small.en" } as Settings,
      diagnostics: diagnostics({ main: { installed: true, python: "3.12", torch: "2.5" }, chatterbox: { installed: false } }),
      engines: [],
      models: [],
    });
  });

  it("asks for the optional Chatterbox env and uv auto-install, then re-runs diagnostics and engines", async () => {
    const { mod } = await h;
    const user = userEvent.setup();
    mod.api.shell.runtimeBootstrap.mockResolvedValue(0);
    render(<SetupPage />);
    await user.click(screen.getByRole("button", { name: "Install optional environments" }));
    await waitFor(() => expect(mod.api.shell.runtimeBootstrap).toHaveBeenCalledWith({ withChatterbox: true, autoInstallUv: true }));
    await waitFor(() => expect(mod.api.system.diagnostics).toHaveBeenCalled());
    expect(mod.api.engine.list).toHaveBeenCalled();
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.title === "Environment setup finished")).toBe(true));
  });

  it("does not ask for Chatterbox again when it is already installed", async () => {
    const { mod } = await h;
    const user = userEvent.setup();
    useAppStore.setState({ diagnostics: diagnostics({ main: { installed: false }, chatterbox: { installed: true } }) });
    mod.api.shell.runtimeBootstrap.mockResolvedValue(0);
    render(<SetupPage />);
    await user.click(screen.getByRole("button", { name: "Install environments" }));
    await waitFor(() => expect(mod.api.shell.runtimeBootstrap).toHaveBeenCalledWith({ withChatterbox: false, autoInstallUv: true }));
  });

  it("treats a rejected bootstrap as a failure and still refreshes the probes", async () => {
    const { mod } = await h;
    const user = userEvent.setup();
    mod.api.shell.runtimeBootstrap.mockRejectedValue({ code: "INTERNAL", message: "bootstrap.sh exited with code 1", details: { code: 1 }, recoverable: true });
    render(<SetupPage />);
    await user.click(screen.getByRole("button", { name: "Install optional environments" }));
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.title === "Environment setup failed")).toBe(true));
    expect(useToastStore.getState().toasts.some((t) => t.title === "Environment setup finished")).toBe(false);
    await waitFor(() => expect(mod.api.system.diagnostics).toHaveBeenCalled());
    expect(mod.api.engine.list).toHaveBeenCalled();
  });
});
