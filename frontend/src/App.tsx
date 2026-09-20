import { useEffect, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { ToastProvider } from "@/components/ui/Toast";
import { Spinner } from "@/components/ui/Spinner";
import { Sidebar } from "@/components/shell/Sidebar";
import { ErrorBoundary } from "@/components/shell/ErrorBoundary";
import { Header, useGpuPolling } from "@/components/shell/Header";
import { ShortcutsHelp, useGlobalShortcuts } from "@/components/shell/ShortcutsHelp";
import { useAppStore, type Page } from "@/store/appStore";
import HomePage from "@/pages/HomePage";
import VoicesPage from "@/pages/VoicesPage";
import CreatePage from "@/pages/CreatePage";
import LibraryPage from "@/pages/LibraryPage";
import SettingsPage from "@/pages/SettingsPage";
import SetupPage from "@/pages/SetupPage";

const PAGES: Record<Page, () => ReactNode> = {
  home: () => <HomePage />,
  voices: () => <VoicesPage />,
  create: () => <CreatePage />,
  library: () => <LibraryPage />,
  settings: () => <SettingsPage />,
  setup: () => <SetupPage />,
};

/** Wires store ↔ shell events once for the app lifetime. */
function useShellSubscriptions() {
  const boot = useAppStore((s) => s.boot);
  const setWorkerStatus = useAppStore((s) => s.setWorkerStatus);
  const applyEngineState = useAppStore((s) => s.applyEngineState);
  const applyModelState = useAppStore((s) => s.applyModelState);
  useEffect(() => {
    // Subscribe before the first boot so a worker that is still starting cannot slip through unnoticed:
    // boot() defers while `running` is false and this handler runs it once the supervisor reports the
    // worker up — the same path (re)loads everything after a restart.
    const offStatus = api.events.onWorkerStatus((s) => {
      const prev = useAppStore.getState().workerStatus;
      setWorkerStatus(s);
      if (s.running && !prev?.running) void boot();
    });
    void boot();
    const offEngine = api.events.on("engine.state", applyEngineState);
    const offModel = api.events.on("model.state", applyModelState);
    return () => {
      offStatus();
      offEngine();
      offModel();
    };
  }, [boot, setWorkerStatus, applyEngineState, applyModelState]);
}

export default function App() {
  useShellSubscriptions();
  useGpuPolling();
  useGlobalShortcuts();
  const page = useAppStore((s) => s.page);
  const booted = useAppStore((s) => s.booted);
  const bootError = useAppStore((s) => s.bootError);
  const boot = useAppStore((s) => s.boot);
  const params = useAppStore((s) => s.params);
  const workerStarting = useAppStore((s) => s.workerStatus != null && !s.workerStatus.running);

  // Fresh page → start at the top (a page that targets a section scrolls itself).
  useEffect(() => {
    if (!params.section) document.getElementById("page")?.scrollTo({ top: 0 });
  }, [page, params]);

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-work text-text">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        <Header />
        <main className="flex-1 min-h-0 overflow-y-auto" id="page">
          {!booted ? (
            <div className="flex items-center justify-center h-full text-muted gap-3" role="status">
              <Spinner size={20} /> {workerStarting ? "Starting local worker…" : "Connecting to the worker…"}
            </div>
          ) : bootError ? (
            <div className="max-w-[560px] mx-auto mt-16 panel p-6 flex flex-col gap-4">
              <div className="flex items-center gap-3 text-danger">
                <AlertTriangle className="size-6" />
                <h2>The worker did not respond</h2>
              </div>
              <p className="text-sm text-muted break-words">{bootError}</p>
              <div className="flex gap-2 flex-wrap">
                <Button variant="primary" onClick={() => void boot()}>
                  Try again
                </Button>
                <Button onClick={() => void api.shell.workerRestart().then(() => boot())}>Restart worker</Button>
                <Button
                  onClick={() => {
                    useAppStore.setState({ bootError: null, page: "setup", booted: true });
                  }}
                >
                  Open setup
                </Button>
              </div>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-[1400px] px-6 py-6 min-[1600px]:px-10">
              <ErrorBoundary resetKey={page}>{PAGES[page]()}</ErrorBoundary>
            </div>
          )}
        </main>
      </div>
      <ShortcutsHelp />
      <ToastProvider />
    </div>
  );
}
