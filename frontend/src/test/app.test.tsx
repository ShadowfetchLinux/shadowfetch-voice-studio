import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

async function renderApp() {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  const api = await import("@/lib/api");
  api.__resetForTests();
  const { useAppStore } = await import("@/store/appStore");
  const { __resetSpeakStore } = await import("@/features/speak/speakStore");
  const { __resetVoicesStore } = await import("@/store/voicesStore");
  __resetSpeakStore();
  __resetVoicesStore();
  useAppStore.setState({ page: "speak", params: {}, booted: false, bootError: null, settings: null, diagnostics: null, engines: [], models: [] });
  const { default: App } = await import("@/App");
  render(<App />);
  return { useAppStore };
}

describe("App shell with the browser preview mock", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.localStorage.clear();
  });

  it("boots through the mock transport into Speak and labels the mock clearly", async () => {
    await renderApp();
    expect(screen.getByText(/preview mock/i)).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Text to speak" }, { timeout: 4000 })).toBeInTheDocument();
    // the mock's saved voices fill the voice menu
    await waitFor(() => expect(screen.getByRole("button", { name: /Voice: Bob/ })).toBeInTheDocument(), { timeout: 4000 });
  });

  it("moves between Speak, Voices and Settings with the top bar", async () => {
    const user = userEvent.setup();
    const { useAppStore } = await renderApp();
    await screen.findByRole("textbox", { name: "Text to speak" }, { timeout: 4000 });
    const nav = screen.getByRole("navigation", { name: "Main" });

    await user.click(within(nav).getByRole("button", { name: "Voices" }));
    expect(await screen.findByRole("heading", { name: "Voices" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sarah" })).toBeInTheDocument(), { timeout: 4000 });
    expect(useAppStore.getState().page).toBe("voices");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Play speech automatically")).toBeInTheDocument();
    // engine and model management are behind Advanced
    expect(screen.queryByText("Models & engines")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    expect(await screen.findByText("Models & engines")).toBeInTheDocument();

    await user.click(within(nav).getByRole("button", { name: "Speak" }));
    expect(await screen.findByRole("textbox", { name: "Text to speak" })).toBeInTheDocument();
  });
});
