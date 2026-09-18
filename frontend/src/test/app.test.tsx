import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

async function renderApp() {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  const api = await import("@/lib/api");
  api.__resetForTests();
  const { useAppStore } = await import("@/store/appStore");
  useAppStore.setState({ page: "home", params: {}, booted: false, bootError: null, settings: null, diagnostics: null, engines: [], models: [] });
  const { default: App } = await import("@/App");
  render(<App />);
  return { useAppStore };
}

describe("App shell with the browser preview mock", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("boots through the mock transport and labels it clearly", async () => {
    await renderApp();
    expect(screen.getByText("Shadowfetch")).toBeInTheDocument();
    expect(screen.getByText("Voice Studio")).toBeInTheDocument();
    expect(screen.getByText(/preview mock/i)).toBeInTheDocument();
    // mock settings have onboarding_done=false → the guided setup opens first
    await waitFor(() => expect(screen.getByText("Let's check this machine")).toBeInTheDocument(), { timeout: 4000 });
    await waitFor(() => expect(screen.getByText(/Worker: running/)).toBeInTheDocument());
    // diagnostics arrive from the mock and are rendered truthfully (mock-labelled)
    await waitFor(() => expect(screen.getAllByText(/Mock GPU \(mock\)/).length).toBeGreaterThan(0), { timeout: 4000 });
  });

  it("navigates with the sidebar and number-key shortcuts", async () => {
    const user = userEvent.setup();
    await renderApp();
    await waitFor(() => expect(screen.getByText("Let's check this machine")).toBeInTheDocument(), { timeout: 4000 });
    await user.click(screen.getByRole("button", { name: /^Home/ }));
    expect(screen.getByText("Record a voice")).toBeInTheDocument();
    expect(screen.getByText("Import audio")).toBeInTheDocument();
    expect(screen.getByText("Create speech")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Preview project 1 \(mock\)/)).toBeInTheDocument(), { timeout: 4000 });

    await user.keyboard("5");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument());
    expect(screen.getByText("Audio devices")).toBeInTheDocument();
    expect(screen.getByText("Engines & models")).toBeInTheDocument();

    await user.keyboard("?");
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
