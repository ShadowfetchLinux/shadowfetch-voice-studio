import { useEffect } from "react";
import { Cpu, HardDrive, Keyboard, RefreshCw, WifiOff } from "lucide-react";
import { api } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { IconButton } from "@/components/ui/Button";
import { StatusPill, Tooltip } from "@/components/ui/Feedback";
import { useLoadedEngine, useAppStore, type Page } from "@/store/appStore";

const PAGE_TITLES: Record<Page, string> = {
  home: "Home",
  voices: "Voices",
  create: "Create",
  library: "Library",
  settings: "Settings",
  setup: "First-run setup",
};

const GPU_POLL_MS = 5000;

/** Polls `system.gpu_status` every 5 s while the window has focus (and stops when it doesn't). */
export function useGpuPolling() {
  const refreshGpu = useAppStore((s) => s.refreshGpu);
  const booted = useAppStore((s) => s.booted);
  useEffect(() => {
    if (!booted) return;
    let timer: number | null = null;
    const tick = () => {
      if (document.hasFocus() && document.visibilityState === "visible") void refreshGpu();
    };
    const start = () => {
      if (timer == null) timer = window.setInterval(tick, GPU_POLL_MS);
      tick();
    };
    const stop = () => {
      if (timer != null) window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    window.addEventListener("focus", start);
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", onVisibility);
    if (document.hasFocus()) start();
    return () => {
      stop();
      window.removeEventListener("focus", start);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [booted, refreshGpu]);
}

function WorkerPill() {
  const status = useAppStore((s) => s.workerStatus);
  const mock = useAppStore((s) => s.mock);
  if (!status) return <StatusPill tone="neutral" dot>Worker: connecting</StatusPill>;
  if (status.stopped) return <StatusPill tone="danger" dot>Worker: stopped</StatusPill>;
  if (!status.running) {
    return (
      <Tooltip content={status.last_error ? `Last error: ${status.last_error}` : "The worker process is being restarted"}>
        <StatusPill tone="warn" dot pulse tabIndex={0}>
          Worker: {status.restarts > 0 ? `restarting (${status.restarts})` : "down"}
        </StatusPill>
      </Tooltip>
    );
  }
  return (
    <StatusPill tone="success" dot>
      Worker: running{mock ? " (mock)" : status.restarts ? ` · ${status.restarts} restart${status.restarts === 1 ? "" : "s"}` : ""}
    </StatusPill>
  );
}

function EnginePill() {
  const loaded = useLoadedEngine();
  if (!loaded) return <StatusPill tone="neutral">No engine loaded</StatusPill>;
  const loading = loaded.state.state === "loading";
  return (
    <StatusPill tone={loading ? "warn" : "accent"} dot pulse={loading}>
      {loading ? "Loading " : ""}
      {loaded.engine.name}
      {loaded.state.model_id ? ` · ${loaded.state.model_id}` : ""}
      {loaded.state.vram_bytes ? ` · ${formatBytes(loaded.state.vram_bytes, 1)} VRAM` : ""}
    </StatusPill>
  );
}

function GpuPill() {
  const gpu = useAppStore((s) => s.gpu?.gpus[0] ?? s.diagnostics?.gpus[0] ?? null);
  const hasStatus = useAppStore((s) => s.gpu != null || s.diagnostics != null);
  if (!hasStatus) return <StatusPill tone="neutral" icon={<Cpu />}>GPU: …</StatusPill>;
  if (!gpu) return <StatusPill tone="warn" icon={<Cpu />}>No NVIDIA GPU detected</StatusPill>;
  return (
    <StatusPill tone="neutral" icon={<Cpu />}>
      {gpu.name} · {formatBytes(gpu.vram_used_bytes, 1)} / {formatBytes(gpu.vram_total_bytes, 0)}
      {gpu.utilization_pct != null ? ` · ${gpu.utilization_pct}%` : ""}
    </StatusPill>
  );
}

function DiskPill() {
  const disk = useAppStore((s) => s.diagnostics?.disk ?? null);
  if (!disk) return null;
  const low = disk.free_bytes < 5 * 2 ** 30;
  return (
    <StatusPill tone={low ? "warn" : "neutral"} icon={<HardDrive />}>
      {formatBytes(disk.free_bytes, 0)} free
    </StatusPill>
  );
}

function OfflinePill() {
  const offline = useAppStore((s) => s.settings?.offline ?? s.diagnostics?.offline ?? false);
  if (!offline) return null;
  return (
    <StatusPill tone="dark" icon={<WifiOff />}>
      Offline mode
    </StatusPill>
  );
}

/** Top bar: page title, real status pills from the store, and the shortcuts help button. */
export function Header() {
  const page = useAppStore((s) => s.page);
  const mock = useAppStore((s) => s.mock);
  const setShortcutsOpen = useAppStore((s) => s.setShortcutsOpen);
  const status = useAppStore((s) => s.workerStatus);
  return (
    <header className="flex items-center gap-3 h-16 px-6 border-b border-border bg-panel/70 backdrop-blur-sm shrink-0">
      <h1 className="text-[18px] shrink-0">{PAGE_TITLES[page]}</h1>
      {mock && (
        <StatusPill tone="warn" className="uppercase tracking-wide" title="Browser preview: all data is fake and nothing is saved">
          Preview mock
        </StatusPill>
      )}
      <div className="flex items-center justify-end gap-2 ml-auto min-w-0 flex-1 [&>span]:min-w-0" aria-label="Status">
        <WorkerPill />
        {status && !status.running && !status.stopped && (
          <IconButton label="Restart worker" size="sm" onClick={() => void api.shell.workerRestart()}>
            <RefreshCw />
          </IconButton>
        )}
        <EnginePill />
        <GpuPill />
        <OfflinePill />
        <DiskPill />
      </div>
      <IconButton label="Keyboard shortcuts (?)" size="sm" className="shrink-0" onClick={() => setShortcutsOpen(true)}>
        <Keyboard />
      </IconButton>
    </header>
  );
}
