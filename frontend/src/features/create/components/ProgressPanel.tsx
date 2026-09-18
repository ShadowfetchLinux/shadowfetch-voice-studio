import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { ProgressBar, StatusPill } from "@/components/ui/Feedback";
import { cx } from "@/lib/format";
import { useAppStore } from "@/store/appStore";
import { useModelOps } from "@/store/modelOps";
import { useCreateStore } from "../createStore";
import type { CreateError } from "../types";

const STAGE_LABEL: Record<string, string> = {
  queued: "Waiting for the GPU",
  prepare: "Preparing the voice reference",
  engine: "Loading the engine",
  generate: "Generating",
  assemble: "Assembling",
  compare: "Comparing engines",
};

function RecoveryActions({ error }: { error: CreateError }) {
  const navigate = useAppStore((s) => s.navigate);
  const engines = useAppStore((s) => s.engines);
  const engineStates = useAppStore((s) => s.engineStates);
  const unloadEngine = useModelOps((s) => s.unloadEngine);
  const engineId = useCreateStore((s) => s.engineId);
  const retry = useCreateStore((s) => s.retry);
  const setSegmentationOpen = useCreateStore((s) => s.setSegmentationOpen);
  const busy = useCreateStore((s) => s.job != null);

  const otherLoaded = engines.filter((e) => e.id !== engineId && (engineStates[e.id]?.state ?? e.state) === "loaded");
  const settings = (
    <Button size="sm" onClick={() => navigate("settings", { section: "engines" })}>
      Open Settings
    </Button>
  );
  const retryBtn = error.retry || error.context === "plan" || error.context === "assemble" || error.context === "save" ? (
    <Button size="sm" variant="primary" disabled={busy} onClick={() => void retry()}>
      Retry
    </Button>
  ) : null;

  switch (error.code) {
    case "GPU_OOM":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-[12.5px]">The GPU ran out of memory. Free VRAM by unloading other engines, or shorten segments (lower “Max characters per segment” under Segmentation) and plan again.</p>
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" disabled={otherLoaded.length === 0 || busy} onClick={() => otherLoaded.forEach((e) => void unloadEngine(e.id))}>
              Unload other engines{otherLoaded.length ? ` (${otherLoaded.length})` : ""}
            </Button>
            <Button size="sm" onClick={() => setSegmentationOpen(true)}>
              Shorten segments
            </Button>
            {retryBtn}
          </div>
        </div>
      );
    case "MODEL_MISSING":
    case "MODEL_INVALID":
    case "ENGINE_UNAVAILABLE":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-[12.5px]">The engine's model or environment is not ready. Install or verify it in Settings, then retry.</p>
          <div className="flex gap-2">
            {settings}
            {retryBtn}
          </div>
        </div>
      );
    case "ENGINE_CRASHED":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-[12.5px]">The engine process died mid-job. Completed segments were kept; retrying starts a fresh engine process.</p>
          <div className="flex gap-2">{retryBtn}</div>
        </div>
      );
    case "OFFLINE_BLOCKED":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-[12.5px]">Offline mode is on and this step needed the network (for example a model download). Nothing was sent. Turn offline mode off in Settings if you want to allow it, or install the model from a local folder.</p>
          <div className="flex gap-2">{settings}</div>
        </div>
      );
    default:
      return retryBtn ? <div className="flex gap-2">{retryBtn}</div> : null;
  }
}

/** Persistent job/progress panel: measured progress, engine state pill, success notice and error banners. */
export function ProgressPanel() {
  const job = useCreateStore((s) => s.job);
  const error = useCreateStore((s) => s.error);
  const notice = useCreateStore((s) => s.notice);
  const dismissError = useCreateStore((s) => s.dismissError);
  const engineId = useCreateStore((s) => s.engineId);
  const engineLive = useAppStore((s) => (engineId ? s.engineStates[engineId] : undefined));
  const engineInfo = useAppStore((s) => s.engines.find((e) => e.id === engineId));
  const engineState = engineLive?.state ?? engineInfo?.state ?? "unloaded";
  const engineMsg = engineLive?.message ?? engineInfo?.message;

  if (!job && !error && !notice) return null;

  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      {job && (
        <div className="panel px-4 py-3 flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{job.label}</span>
            <StatusPill tone="accent" size="sm" dot pulse>
              {STAGE_LABEL[job.stage] ?? job.stage}
            </StatusPill>
            <StatusPill tone={engineState === "loaded" ? "success" : engineState === "loading" ? "warn" : engineState === "error" ? "danger" : "neutral"} size="sm" dot pulse={engineState === "loading"}>
              engine {engineState}
            </StatusPill>
            {job.cancelling && (
              <StatusPill tone="warn" size="sm">
                cancelling…
              </StatusPill>
            )}
          </div>
          <ProgressBar current={job.current} total={job.total} unit={job.kind === "generate" ? "segments" : undefined} label={job.message} />
          {engineState === "loading" && engineMsg && <p className="text-[12.5px] text-muted">{engineMsg}</p>}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className={cx("panel px-4 py-3 flex items-start gap-3", error.code === "CANCELLED" ? "border-warn/50" : "border-danger/50")}
        >
          {error.code === "CANCELLED" ? <Info className="size-5 text-warn shrink-0 mt-0.5" /> : <AlertTriangle className="size-5 text-danger shrink-0 mt-0.5" />}
          <div className="min-w-0 flex-1 flex flex-col gap-2">
            <div>
              <p className="text-sm font-medium">
                {error.code === "CANCELLED" ? "Cancelled" : `${error.context === "generate" ? "Generation" : error.context === "plan" ? "Planning" : error.context === "assemble" ? "Assembly" : error.context === "compare" ? "Comparison" : "Request"} failed`}
                <code className="ml-2 text-[11.5px] text-muted">{error.code}</code>
              </p>
              <p className="text-[13px] text-text mt-0.5 break-words">
                {error.code === "CANCELLED"
                  ? `${error.completed} completed segment${error.completed === 1 ? "" : "s"} ${error.completed === 1 ? "was" : "were"} kept.`
                  : error.message}
                {error.code !== "CANCELLED" && error.completed > 0 ? ` ${error.completed} completed segment${error.completed === 1 ? "" : "s"} ${error.completed === 1 ? "was" : "were"} kept.` : ""}
                {!error.recoverable && error.code !== "CANCELLED" ? " A worker restart may be required." : ""}
              </p>
            </div>
            {error.code !== "CANCELLED" && <RecoveryActions error={error} />}
          </div>
          <IconButton size="sm" label="Dismiss" onClick={dismissError}>
            <X />
          </IconButton>
        </div>
      )}
      {!job && !error && notice && (
        <div role="status" className="panel px-4 py-3 flex items-center gap-3">
          <CheckCircle2 className="size-5 text-success shrink-0" />
          <p className="text-[13px] flex-1">{notice}</p>
          <IconButton size="sm" label="Dismiss notice" onClick={() => useCreateStore.setState({ notice: null })}>
            <X />
          </IconButton>
        </div>
      )}
    </div>
  );
}
