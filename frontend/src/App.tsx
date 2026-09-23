import { useEffect, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { ToastProvider } from "@/components/ui/Toast";
import { Spinner } from "@/components/ui/Spinner";
import { ErrorBoundary } from "@/components/shell/ErrorBoundary";
import { TopBar, WorkerBanner } from "@/components/shell/TopBar";
import { useAppStore, type Page } from "@/store/appStore";
import { useGpuPolling } from "@/store/useGpuPolling";
import { useVoicesStore } from "@/store/voicesStore";
import { useSpeakStore } from "@/features/speak/speakStore";
import { ModelSetupDialog } from "@/features/setup/ModelSetupDialog";
import { CloneVoiceDialog } from "@/features/voices/clone/CloneVoiceDialog";
import SpeakPage from "@/pages/SpeakPage";
import VoicesPage from "@/pages/VoicesPage";
import SettingsPage from "@/pages/SettingsPage";
import SetupPage from "@/pages/SetupPage";
import LibraryPage from "@/pages/LibraryPage";
import CreatePage from "@/pages/CreatePage";

/** Pages that fill the window themselves (Speak's editor grows with it); the rest scroll inside a padded column. */
const PAGES: Record<Page, { render: () => ReactNode; bare?: boolean }> = {
  speak: { render: () => <SpeakPage />, bare: true },
  voices: { render: () => <VoicesPage />, bare: true },
  settings: { render: () => <SettingsPage /> },
  setup: { render: () => <SetupPage /> },
  projects: { render: () => <LibraryPage /> },
  editor: { render: () => <CreatePage /> },
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
      if (s.running && !prev?.running) {
        void boot();
        // after a restart: refresh the voices, and load Speak again if its first load failed while the worker was down
        if (prev) {
          void useVoicesStore.getState().load();
          const sp = useSpeakStore.getState();
          if (sp.loadError || (sp.ready && !sp.projectId)) void sp.init();
        }
      }
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
  const page = useAppStore((s) => s.page);
  const booted = useAppStore((s) => s.booted);
  const bootError = useAppStore((s) => s.bootError);
  const boot = useAppStore((s) => s.boot);
  const params = useAppStore((s) => s.params);
  const workerStarting = useAppStore((s) => s.workerStatus != null && !s.workerStatus.running);
  useGpuPolling(page === "settings" || page === "editor" || page === "setup");

  // Fresh page → start at the top (a page that targets a section scrolls itself).
  useEffect(() => {
    if (!params.section) document.getElementById("page")?.scrollTo({ top: 0 });
  }, [page, params]);

  const spec = PAGES[page] ?? PAGES.speak;

  return (
    <div className="flex flex-col h-full min-h-0 w-full overflow-hidden bg-work text-text">
      <TopBar />
      <WorkerBanner />
      <main className="flex-1 min-h-0 overflow-y-auto" id="page">
        {!booted ? (
          <div className="flex items-center justify-center h-full text-muted gap-3" role="status">
            <Spinner size={20} /> {workerStarting ? "Starting Voice Studio…" : "Connecting…"}
          </div>
        ) : bootError ? (
          <div className="max-w-[560px] mx-auto mt-16 panel p-6 flex flex-col gap-4">
            <div className="flex items-center gap-3 text-danger">
              <AlertTriangle className="size-6" />
              <h2>Voice Studio couldn't start its engine</h2>
            </div>
            <p className="text-sm text-muted break-words">{bootError}</p>
            <div className="flex gap-2 flex-wrap">
              <Button variant="primary" onClick={() => void boot()}>
                Try again
              </Button>
              <Button onClick={() => void api.shell.workerRestart().then(() => boot())}>Restart engine</Button>
              <Button
                onClick={() => {
                  useAppStore.setState({ bootError: null, page: "setup", booted: true });
                }}
              >
                Open system check
              </Button>
            </div>
          </div>
        ) : spec.bare ? (
          <ErrorBoundary resetKey={page}>{spec.render()}</ErrorBoundary>
        ) : (
          <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 py-6">
            <ErrorBoundary resetKey={page}>{spec.render()}</ErrorBoundary>
          </div>
        )}
      </main>
      {booted && !bootError && (
        <>
          <CloneVoiceDialog />
          <ModelSetupDialog />
        </>
      )}
      <ToastProvider />
    </div>
  );
}
