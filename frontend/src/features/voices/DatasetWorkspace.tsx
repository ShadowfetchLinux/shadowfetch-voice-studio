import { useEffect, useState } from "react";
import { Database, Pencil } from "lucide-react";
import { api } from "@/lib/api";
import type { DatasetPreflightResult, Progress, Reference, Voice } from "@/lib/protocol";
import { formatDuration, formatTime } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Textarea } from "@/components/ui/Field";
import { Checkbox } from "@/components/ui/Toggle";
import { ProgressBar, StatusPill } from "@/components/ui/Feedback";
import { handleError, toast } from "@/store/appStore";
import { processingSteps } from "./processing";

function clipPath(r: Reference): string | null {
  return r.asset?.working_path ?? r.asset?.original_path ?? null;
}

export interface DatasetWorkspaceProps {
  voice: Voice;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

/**
 * Advanced dataset workspace: review recordings + transcripts, export a Qwen3-TTS fine-tune
 * JSONL, and run the VRAM preflight. Training is not offered (16 GB does not fit 1.7B full SFT).
 */
export function DatasetWorkspace({ voice, open, onClose, onChanged }: DatasetWorkspaceProps) {
  const refs = voice.references ?? [];
  const [preflight, setPreflight] = useState<DatasetPreflightResult | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    api.dataset
      .preflight()
      .then((r) => alive && setPreflight(r))
      .catch((err) => alive && setPreflightError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [open]);

  const ready = refs.filter((r) => r.transcript.trim() && r.transcript_confirmed).length;

  const beginEdit = (r: Reference) => {
    setEditingId(r.id);
    setText(r.transcript);
    setReviewed(false);
  };

  const exportDataset = async () => {
    try {
      const dir = await api.shell.pickDirectory();
      if (!dir) return;
      setExporting(true);
      setProgress(null);
      const res = await api.dataset.export({ voice_id: voice.id, out_dir: dir }, { onProgress: setProgress });
      const skipped = res.skipped.length ? ` · ${res.skipped.length} skipped` : "";
      toast.success(`Dataset exported: ${res.samples} utterance${res.samples === 1 ? "" : "s"}, ${Math.round(res.total_seconds)} s`, `${res.path}${skipped}. Training is not run by this app — see docs/FINETUNING.md.`);
      void api.shell.revealPath(res.jsonl).catch(() => undefined);
    } catch (err) {
      handleError(err, "Dataset export failed");
    } finally {
      setExporting(false);
      setProgress(null);
    }
  };

  const saveTranscript = async () => {
    if (!editingId) return;
    setBusy(true);
    try {
      await api.voices.updateReference({ reference_id: editingId, patch: { transcript: text.trim(), transcript_source: "edited", transcript_confirmed: true } });
      toast.success("Transcript reviewed");
      setEditingId(null);
      onChanged();
    } catch (err) {
      handleError(err, "Could not update the transcript");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Fine-tuning dataset"
      description="Organize this voice's recordings, correct transcripts, and export the official Qwen3-TTS JSONL. The app does not train — full-parameter 1.7B SFT does not fit 16 GB."
      size="lg"
      locked={exporting || busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={exporting || busy}>
            Close
          </Button>
          <Button variant="primary" icon={<Database />} loading={exporting} disabled={ready === 0 || busy} onClick={() => void exportDataset()}>
            Export dataset
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-[var(--radius-panel)] border border-border p-3 text-[13px]">
          {preflight ? (
            <>
              <StatusPill size="sm" tone={preflight.fits ? "warn" : "danger"}>
                {preflight.fits ? "tight fit" : "does not fit"}
              </StatusPill>
              <p className="mt-2 text-muted">{preflight.verdict}</p>
              <p className="mt-1 text-[12px] text-muted">
                {preflight.gpu} · {preflight.vram_total_gb} GB VRAM · estimate {preflight.estimate_gb.total} GB
              </p>
            </>
          ) : preflightError ? (
            <p className="text-warn">Preflight unavailable: {preflightError}</p>
          ) : (
            <p className="text-muted">Checking GPU memory…</p>
          )}
        </div>

        <p className="text-[13px] text-muted">
          {ready} of {refs.length} recording{refs.length === 1 ? "" : "s"} have a reviewed transcript and will be exported. Unreviewed or empty transcripts are skipped.
        </p>

        {refs.length === 0 ? (
          <p className="text-sm text-muted">Add reference recordings to this voice first.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Dataset recordings">
            {refs.map((r) => {
              const hist = processingSteps(r.processing);
              const editing = editingId === r.id;
              return (
                <li key={r.id} className="rounded-[var(--radius-panel)] border border-border p-3 flex flex-col gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{r.label ?? r.id}</span>
                    <StatusPill size="sm" tone={r.transcript_confirmed ? "success" : "warn"}>
                      {r.transcript_confirmed ? "reviewed" : "needs review"}
                    </StatusPill>
                    <span className="text-[12.5px] text-muted tabular-nums">
                      {formatTime(r.start_s, true)} – {formatTime(r.end_s, true)} ({formatDuration(r.end_s - r.start_s)})
                    </span>
                    <span className="flex-1" />
                    {!editing && (
                      <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => beginEdit(r)}>
                        Correct transcript
                      </Button>
                    )}
                  </div>
                  {editing ? (
                    <div className="flex flex-col gap-2">
                      <Textarea label="Transcript" rows={4} value={text} onChange={(e) => { setText(e.target.value); setReviewed(false); }} textareaClassName="text-[15px] leading-relaxed" />
                      <Checkbox label="I reviewed this transcript and it matches the recording" checked={reviewed} onChange={setReviewed} disabled={!text.trim()} />
                      <div className="flex gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} disabled={busy}>
                          Cancel
                        </Button>
                        <Button size="sm" variant="primary" onClick={() => void saveTranscript()} loading={busy} disabled={!text.trim() || !reviewed}>
                          Save transcript
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[13px] line-clamp-2">{r.transcript || <span className="text-muted">No transcript</span>}</p>
                  )}
                  {hist.length > 0 && <p className="text-[12px] text-muted">Processing: {hist.join(" → ")}</p>}
                  {!clipPath(r) && <p className="text-[12px] text-warn">Source audio missing on disk — this clip will be skipped.</p>}
                </li>
              );
            })}
          </ul>
        )}

        {progress && <ProgressBar size="sm" label={progress.message ?? "Exporting…"} current={progress.current} total={progress.total} />}
      </div>
    </Dialog>
  );
}
