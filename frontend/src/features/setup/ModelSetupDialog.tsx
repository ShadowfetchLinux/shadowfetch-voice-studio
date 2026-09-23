import { useEffect, useMemo, useState } from "react";
import { Cpu, Download, WifiOff } from "lucide-react";
import { api } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { friendlyError } from "@/lib/friendlyErrors";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ProgressBar } from "@/components/ui/Feedback";
import { Checkbox } from "@/components/ui/Toggle";
import { useAppStore } from "@/store/appStore";
import { useModelOps } from "@/store/modelOps";
import { readiness, useModelSetup, type ModelNeed } from "@/store/modelSetup";
import { useSpeakStore } from "@/features/speak/speakStore";

function sizeOf(n: ModelNeed): number | null {
  return n.model.size_bytes ?? n.model.approx_size_bytes ?? null;
}

/** Short model name for people ("Qwen3-TTS 1.7B", "Whisper small (English)"). */
function displayName(n: ModelNeed): string {
  const repo = n.model.repo.split("/").pop() ?? n.model.id;
  if (/qwen3-tts/i.test(repo)) return "Qwen3-TTS 1.7B";
  if (/chatterbox/i.test(repo)) return "Chatterbox-Turbo";
  const w = repo.match(/whisper-([a-z0-9.-]+?)(\.en)?(-ct2)?$/i);
  if (w) return `Whisper ${w[1]}${w[2] ? " (English)" : ""}`;
  return repo;
}

/**
 * "Voice Studio needs its local voice model." — shown the first time Speak or Clone Voice needs a model that is not
 * installed. Lists exactly what will be downloaded (size, source, license), downloads only after the click, respects
 * offline mode, and resolves the waiting action when everything is installed.
 */
export function ModelSetupDialog() {
  const open = useModelSetup((s) => s.open);
  const purpose = useModelSetup((s) => s.purpose);
  const finish = useModelSetup((s) => s.finish);
  const engines = useAppStore((s) => s.engines);
  const models = useAppStore((s) => s.models);
  const settings = useAppStore((s) => s.settings);
  const navigate = useAppStore((s) => s.navigate);
  const preferredEngine = useSpeakStore((s) => s.engineOverride);
  const downloads = useModelOps((s) => s.downloads);
  const errors = useModelOps((s) => s.errors);
  const [running, setRunning] = useState(false);
  const [switchingOffline, setSwitchingOffline] = useState(false);
  // Freeze the list when the dialog opens so rows do not vanish mid-download as each one completes.
  const [needs, setNeeds] = useState<ModelNeed[]>([]);
  // Optional models (e.g. the voice model while cloning) are offered, pre-selected, and can be left for later.
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const r = useMemo(() => readiness(purpose, engines, models, settings, preferredEngine), [purpose, engines, models, settings, preferredEngine]);

  useEffect(() => {
    if (!open) return;
    setNeeds(r.needs);
    setSkipped({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A download that is already running (started from Settings, or before a restart of this dialog) is joined.
  useEffect(() => {
    if (open && !running && needs.some((n) => useModelOps.getState().downloads[n.model.id])) void downloadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, needs]);

  // Close by itself once everything required is installed (e.g. a download finished).
  useEffect(() => {
    if (open && !running && r.ready && needs.length > 0 && needs.every((n) => models.find((m) => m.id === n.model.id)?.state === "installed")) finish(true);
  }, [open, running, r.ready, needs, models, finish]);

  const offline = settings?.offline ?? false;
  const chosen = needs.filter((n) => n.required || !skipped[n.model.id]);
  const total = chosen.reduce((a, n) => a + (sizeOf(n) ?? 0), 0);
  const failed = needs.map((n) => errors[n.model.id]).find(Boolean);
  const title = purpose === "clone" ? "Voice Studio needs its local models" : "Voice Studio needs its local voice model";

  const downloadAll = async () => {
    setRunning(true);
    try {
      for (const n of chosen) {
        const state = useAppStore.getState().models.find((m) => m.id === n.model.id)?.state;
        if (state === "installed") continue;
        const ok = await useModelOps.getState().startDownload(n.model.id, { quiet: true });
        if (!ok) return;
      }
      await Promise.all([useAppStore.getState().loadModels(), useAppStore.getState().loadEngines()]);
      const app = useAppStore.getState();
      if (readiness(purpose, app.engines, app.models, app.settings, preferredEngine).ready) finish(true);
    } finally {
      setRunning(false);
    }
  };

  const cancel = async () => {
    for (const n of needs) if (useModelOps.getState().downloads[n.model.id]) await useModelOps.getState().cancelDownload(n.model.id);
  };

  const turnOffOffline = async () => {
    setSwitchingOffline(true);
    try {
      await api.system.setOffline(false);
      await useAppStore.getState().loadSettings();
    } finally {
      setSwitchingOffline(false);
    }
  };

  if (r.engineMissing) {
    return (
      <Dialog
        open={open}
        onClose={() => finish(false)}
        title="Voice Studio isn't fully set up yet"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => finish(false)}>
              Not now
            </Button>
            <Button
              variant="primary"
              icon={<Cpu />}
              onClick={() => {
                finish(false);
                navigate("setup");
              }}
            >
              Open system check
            </Button>
          </>
        }
      >
        <p className="text-sm">The speech engine that runs on this computer isn't installed. The system check installs it and tells you if anything else is missing.</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={() => (running ? undefined : finish(false))}
      locked={running}
      title={title}
      description="Downloaded once. After that everything runs on this computer, even offline."
      size="md"
      footer={
        running ? (
          <Button variant="ghost" onClick={() => void cancel()}>
            Cancel download
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => finish(false)}>
              Not now
            </Button>
            <Button variant="primary" icon={<Download />} disabled={offline || chosen.length === 0} onClick={() => void downloadAll()}>
              {chosen.length > 1 ? `Download models (${formatBytes(total, 1)})` : "Download model"}
            </Button>
          </>
        )
      }
    >
      {needs.length === 0 && (
        <div className="text-[14px] flex flex-col gap-3">
          <p>The models look installed, but Voice Studio could not use them. Checking them usually finds a missing or damaged file.</p>
          <Button
            className="self-start"
            onClick={() => {
              finish(false);
              navigate("settings", { section: "engines" });
            }}
          >
            Check the models
          </Button>
        </div>
      )}
      <ul className="flex flex-col gap-3" aria-label="Models to download">
        {needs.map((n) => {
          const job = downloads[n.model.id];
          const size = sizeOf(n);
          const installed = models.find((m) => m.id === n.model.id)?.state === "installed";
          return (
            <li key={n.model.id} className="rounded-[var(--radius-control)] border border-border px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-semibold">
                  {displayName(n)} <span className="font-normal text-muted">· {n.role}</span>
                </p>
                <span className="text-sm tabular-nums text-muted shrink-0">{installed ? "Installed" : size ? `about ${formatBytes(size, 1)}` : "size unknown"}</span>
              </div>
              <p className="text-[13px] text-muted mt-0.5">{n.runsOn}</p>
              <p className="text-[12px] text-muted mt-1.5 break-all">
                Source: {n.model.repo}
                {n.model.revision_pinned ? ` @ ${n.model.revision_pinned.slice(0, 10)}` : ""} · License: {n.model.license}
              </p>
              {!n.required && !installed && !running && (
                <Checkbox
                  className="mt-2"
                  label="Download it now too"
                  description="Needed to speak with your voice. You can also get it the first time you press Speak."
                  checked={!skipped[n.model.id]}
                  onChange={(v) => setSkipped((s) => ({ ...s, [n.model.id]: !v }))}
                />
              )}
              {job && (
                <ProgressBar
                  className="mt-2.5"
                  size="sm"
                  label={job.stage === "verify" || /verif/i.test(job.message) ? "Checking the download…" : "Downloading…"}
                  current={job.bytes_done}
                  total={job.bytes_total ?? size}
                  caption={job.bytes_done != null ? `${formatBytes(job.bytes_done, 1)} of ${formatBytes(job.bytes_total ?? size, 1)}` : undefined}
                />
              )}
            </li>
          );
        })}
      </ul>
      {offline && (
        <div className="mt-4 flex items-start gap-3 rounded-[var(--radius-control)] bg-panel-alt border border-border px-4 py-3 text-[13px]">
          <WifiOff className="size-4 mt-0.5 shrink-0 text-muted" />
          <div className="flex-1">
            <p>Offline mode is on, so nothing can be downloaded.</p>
            <Button size="sm" className="mt-2" loading={switchingOffline} onClick={() => void turnOffOffline()}>
              Turn off offline mode
            </Button>
          </div>
        </div>
      )}
      {failed && !running && (
        <p role="alert" className="mt-4 text-[13px] text-danger">
          {friendlyError(failed, "model").message}
        </p>
      )}
    </Dialog>
  );
}
