import { useState } from "react";
import { Download, ExternalLink, FolderInput, ShieldCheck, Trash2, X } from "lucide-react";
import type { ModelInfo } from "@/lib/protocol";
import { cx, formatBytes } from "@/lib/format";
import { Button, IconButton } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { ProgressBar, StatusPill, type PillTone } from "@/components/ui/Feedback";
import { useAppStore } from "@/store/appStore";
import { useModelOps } from "@/store/modelOps";

const STATE_TONE: Record<ModelInfo["state"], PillTone> = {
  installed: "success",
  missing: "neutral",
  downloading: "accent",
  verifying: "accent",
  error: "danger",
};

/** Human label for the download size: exact when known, otherwise the registry estimate. */
export function modelSizeLabel(m: ModelInfo): string {
  if (m.size_bytes) return formatBytes(m.size_bytes);
  if (m.approx_size_bytes) return `≈ ${formatBytes(m.approx_size_bytes, 1)}`;
  return "size unknown";
}

export interface ModelRowProps {
  model: ModelInfo;
  /** Extra context shown under the name (e.g. "required for transcription"). */
  note?: string;
  optional?: boolean;
  className?: string;
}

/**
 * One model with its state and the full management surface:
 * Download (license/repo/size confirmed first) · Cancel · Verify · Use existing folder · Remove.
 */
export function ModelRow({ model: m, note, optional, className }: ModelRowProps) {
  const offline = useAppStore((s) => s.settings?.offline ?? false);
  const live = useAppStore((s) => s.modelStates[m.id]);
  const job = useModelOps((s) => s.downloads[m.id]);
  const busy = useModelOps((s) => s.busy[m.id]);
  const ops = useModelOps();
  const [confirmDownload, setConfirmDownload] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const state = live?.state ?? m.state;
  const downloading = state === "downloading" || !!job;
  const bytesDone = job?.bytes_done ?? live?.bytes_done ?? null;
  const bytesTotal = job?.bytes_total ?? live?.bytes_total ?? m.approx_size_bytes ?? null;

  return (
    <div className={cx("flex flex-col gap-3 py-4", className)}>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{m.id}</span>
            <StatusPill tone={STATE_TONE[state]} size="sm" dot pulse={state === "downloading" || state === "verifying"}>
              {state}
            </StatusPill>
            {optional && (
              <StatusPill tone="neutral" size="sm">
                optional
              </StatusPill>
            )}
            <StatusPill tone="neutral" size="sm">
              {m.kind.toUpperCase()}
            </StatusPill>
          </div>
          <p className="text-[12.5px] text-muted mt-1 break-all">
            {m.repo}
            {m.license_url && (
              <span className="inline-flex items-center gap-1 ml-2 select-all" title="Model card URL (copy into a browser)">
                <ExternalLink className="size-3" /> {m.license_url}
              </span>
            )}
          </p>
          <p className="text-[12.5px] text-muted mt-0.5">
            License: <span className="text-text">{m.license}</span> · Size: <span className="text-text">{modelSizeLabel(m)}</span>
            {m.revision_installed ? (
              <>
                {" "}
                · Revision: <span className="font-mono text-text">{m.revision_installed.slice(0, 12)}</span>
              </>
            ) : null}
          </p>
          {(note || m.description) && <p className="text-[12.5px] text-muted mt-0.5">{note ?? m.description}</p>}
          {m.path && state === "installed" && <p className="text-[12px] text-muted mt-0.5 font-mono break-all">{m.path}</p>}
          {(m.error || live?.message) && state === "error" && (
            <p className="text-[12.5px] text-danger mt-1" role="alert">
              {m.error ?? live?.message}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          {downloading ? (
            <Button size="sm" variant="secondary" icon={<X />} onClick={() => void ops.cancelDownload(m.id)}>
              Cancel
            </Button>
          ) : state === "installed" ? (
            <>
              <Button size="sm" icon={<ShieldCheck />} loading={busy === "verify"} onClick={() => void ops.verify(m.id)}>
                Verify
              </Button>
              <IconButton size="sm" label="Remove model files" loading={busy === "remove"} onClick={() => setConfirmRemove(true)}>
                <Trash2 />
              </IconButton>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="primary"
                icon={<Download />}
                disabled={offline || state === "verifying"}
                title={offline ? "Offline mode is on — downloads are blocked" : undefined}
                onClick={() => setConfirmDownload(true)}
              >
                Download
              </Button>
              <Button size="sm" icon={<FolderInput />} loading={busy === "use_existing"} onClick={() => void ops.useExistingDir(m.id)} title="Point to a folder that already contains this model">
                Use existing folder
              </Button>
            </>
          )}
        </div>
      </div>
      {downloading && (
        <ProgressBar
          label={job?.message ?? live?.message ?? "Downloading"}
          current={bytesDone}
          total={bytesDone != null ? bytesTotal : null}
          caption={bytesDone != null ? `${formatBytes(bytesDone)}${bytesTotal ? ` of ${formatBytes(bytesTotal)}` : ""}` : undefined}
          size="sm"
        />
      )}

      <ConfirmDialog
        open={confirmDownload}
        onCancel={() => setConfirmDownload(false)}
        onConfirm={() => {
          setConfirmDownload(false);
          void ops.startDownload(m.id);
        }}
        title={`Download ${m.id}?`}
        confirmLabel="Download"
      >
        <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
          <dt className="text-muted">Repository</dt>
          <dd className="break-all">{m.repo}</dd>
          {m.companions && m.companions.length > 0 && (
            <>
              <dt className="text-muted">Also fetches</dt>
              <dd className="break-all">{m.companions.join(", ")}</dd>
            </>
          )}
          <dt className="text-muted">License</dt>
          <dd>{m.license}</dd>
          <dt className="text-muted">Download size</dt>
          <dd>{modelSizeLabel(m)}</dd>
          <dt className="text-muted">Revision</dt>
          <dd className="font-mono">{m.revision_pinned ?? "latest (pinned after download)"}</dd>
        </dl>
        <p className="mt-3 text-muted">The files come from Hugging Face over the network and are stored in the app's models folder. Review the license on the model card before use.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmRemove}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => {
          setConfirmRemove(false);
          await ops.remove(m.id);
        }}
        title={`Remove ${m.id}?`}
        confirmLabel="Remove files"
        destructive
      >
        <p>This deletes the downloaded model files ({modelSizeLabel(m)}). Your voices, recordings and projects are not affected; the engine that uses this model will refuse to load until it is installed again.</p>
      </ConfirmDialog>
    </div>
  );
}
