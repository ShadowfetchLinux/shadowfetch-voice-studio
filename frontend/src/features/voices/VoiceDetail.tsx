import { useState } from "react";
import { Captions, CheckCircle2, Database, Pencil, Plus, Scissors } from "lucide-react";
import { api } from "@/lib/api";
import type { Progress, Reference, Voice } from "@/lib/protocol";
import { cx, formatDuration, formatRelative, formatTime } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Textarea } from "@/components/ui/Field";
import { Checkbox } from "@/components/ui/Toggle";
import { EmptyState, ProgressBar, StatusPill } from "@/components/ui/Feedback";
import { handleError, toast, useAppStore } from "@/store/appStore";
import { DatasetWorkspace } from "./DatasetWorkspace";
import { processingSteps } from "./processing";

export interface VoiceDetailProps {
  voice: Voice;
  onAddReference: () => void;
  onChanged: () => void;
}

/** Path the reference's audio can be transcribed from: the decoded working file, else the original (`voices.*` attach the asset summary). */
export function referenceAudioPath(r: Reference): string | null {
  return r.asset?.working_path ?? r.asset?.original_path ?? null;
}

/** Right column for a selected voice: its reference variants with transcript preview, activation, edit and re-transcribe. */
export function VoiceDetail({ voice, onAddReference, onChanged }: VoiceDetailProps) {
  const settings = useAppStore((s) => s.settings);
  const refs = voice.references ?? [];
  const [datasetOpen, setDatasetOpen] = useState(false);
  const [editing, setEditing] = useState<Reference | null>(null);
  const [text, setText] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asr, setAsr] = useState<{ id: string; progress: Progress | null } | null>(null);
  const [trimming, setTrimming] = useState<Reference | null>(null);
  const [trimStart, setTrimStart] = useState("");
  const [trimEnd, setTrimEnd] = useState("");

  const select = async (r: Reference) => {
    try {
      await api.voices.selectReference({ voice_id: voice.id, reference_id: r.id });
      onChanged();
    } catch (err) {
      handleError(err, "Could not select the reference");
    }
  };

  const openEdit = (r: Reference, initial?: string) => {
    setEditing(r);
    setText(initial ?? r.transcript);
    setReviewed(false);
  };

  const openTrim = (r: Reference) => {
    setTrimming(r);
    setTrimStart(r.start_s.toFixed(3));
    setTrimEnd(r.end_s.toFixed(3));
  };

  const saveTranscript = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await api.voices.updateReference({ reference_id: editing.id, patch: { transcript: text.trim(), transcript_source: "edited", transcript_confirmed: true } });
      toast.success("Transcript updated", "Derived engine files for this reference will be rebuilt on next use.");
      setEditing(null);
      onChanged();
    } catch (err) {
      handleError(err, "Could not update the transcript");
    } finally {
      setBusy(false);
    }
  };

  const saveTrim = async () => {
    if (!trimming) return;
    const start_s = Number(trimStart);
    const end_s = Number(trimEnd);
    if (!Number.isFinite(start_s) || !Number.isFinite(end_s) || end_s <= start_s) {
      toast.error("Invalid trim", "End must be after start.");
      return;
    }
    setBusy(true);
    try {
      await api.voices.updateReference({ reference_id: trimming.id, patch: { trim: { start_s, end_s } } });
      toast.success("Trim updated", "The previous transcript is marked unreviewed — confirm it still matches the new selection.");
      setTrimming(null);
      onChanged();
    } catch (err) {
      handleError(err, "Could not update the trim");
    } finally {
      setBusy(false);
    }
  };

  const retranscribe = async (r: Reference) => {
    const path = referenceAudioPath(r);
    if (!path) return;
    setAsr({ id: r.id, progress: null });
    try {
      const res = await api.transcribe.run({ path, start_s: r.start_s, end_s: r.end_s, model_id: settings?.asr_model, device: settings?.asr_device, language: voice.language }, { onProgress: (p) => setAsr({ id: r.id, progress: p }) });
      openEdit(r, res.text.trim());
    } catch (err) {
      handleError(err, "Transcription failed");
    } finally {
      setAsr(null);
    }
  };

  return (
    <Card
      title={voice.name}
      description={`${voice.language.toUpperCase()} · ${refs.length} recording${refs.length === 1 ? "" : "s"} · updated ${formatRelative(voice.updated_at)}${voice.notes ? ` · ${voice.notes}` : ""}`}
      actions={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" icon={<Database />} disabled={refs.length === 0} onClick={() => setDatasetOpen(true)} title="Advanced: review recordings and export a fine-tuning dataset. No training happens in the app.">
            Dataset workspace
          </Button>
          <Button size="sm" variant="primary" icon={<Plus />} onClick={onAddReference}>
            Add recording
          </Button>
        </div>
      }
    >
      <p className="text-[12.5px] text-muted mb-3" data-testid="voice-rights">
        {voice.rights_confirmed
          ? `Rights confirmed${voice.rights_note ? ` — ${voice.rights_note}` : " (own voice or authorized use)"}.`
          : "Rights have not been confirmed for this voice."}
      </p>
      {refs.length === 0 ? (
        <EmptyState compact title="No recording yet" text="Add a short sample so this voice can be used to generate speech." action={<Button variant="primary" icon={<Plus />} onClick={onAddReference}>Add recording</Button>} />
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Reference variants">
          {refs.map((r) => {
            const active = r.id === voice.selected_reference_id;
            const hist = processingSteps(r.processing);
            const canAsr = !!referenceAudioPath(r);
            return (
              <li key={r.id} className={cx("rounded-[var(--radius-panel)] border p-4 flex flex-col gap-2", active ? "border-accent bg-accent-soft/30" : "border-border")}>
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="inline-flex items-center gap-2 text-sm font-medium cursor-pointer">
                    <input type="radio" name={`active-ref-${voice.id}`} checked={active} onChange={() => void select(r)} className="size-4 accent-accent" aria-label={`Use ${r.label ?? "this reference"} as the active reference`} />
                    {r.label ?? `Reference ${refs.indexOf(r) + 1}`}
                  </label>
                  {active && (
                    <StatusPill size="sm" tone="success" icon={<CheckCircle2 />}>
                      active
                    </StatusPill>
                  )}
                  <StatusPill size="sm" tone={r.transcript_confirmed ? "success" : "warn"}>
                    {r.transcript_confirmed ? "transcript reviewed" : "transcript needs review"}
                  </StatusPill>
                  <span className="text-[12.5px] text-muted tabular-nums">
                    {formatTime(r.start_s, true)} – {formatTime(r.end_s, true)} ({formatDuration(r.end_s - r.start_s)})
                    {r.transcript_source ? ` · transcript ${r.transcript_source === "asr" ? `by ${r.asr_model ?? "ASR"}` : "edited"}` : ""}
                  </span>
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" icon={<Scissors />} onClick={() => openTrim(r)}>
                    Edit trim
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => openEdit(r)}>
                    Edit transcript
                  </Button>
                  {canAsr && (
                    <Button size="sm" variant="ghost" icon={<Captions />} loading={asr?.id === r.id} onClick={() => void retranscribe(r)}>
                      Re-transcribe
                    </Button>
                  )}
                </div>
                {asr?.id === r.id && <ProgressBar size="sm" label={asr.progress?.message ?? "Starting transcription…"} />}
                <p className="text-[13px] text-text leading-relaxed line-clamp-3" title={r.transcript}>
                  {r.transcript}
                </p>
                <p className="text-[12px] text-muted" data-testid="processing-history">
                  {hist.length > 0 ? `Processing history (derived copy, in order): ${hist.join(" → ")}` : "No optional processing — original selection only."}
                </p>
                {r.derived && Object.keys(r.derived).length > 0 && <p className="text-[12px] text-muted">Prepared for: {Object.keys(r.derived).join(", ")}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {!refs.some((r) => referenceAudioPath(r)) && refs.length > 0 && <p className="mt-3 text-[12px] text-muted">Re-transcribe is unavailable: the source recordings of these references are no longer in the library. Edit the transcript by hand instead.</p>}

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Edit reference transcript"
        locked={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void saveTranscript()} loading={busy} disabled={!text.trim() || !reviewed}>
              Save transcript
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Textarea label="Transcript" rows={6} value={text} onChange={(e) => { setText(e.target.value); setReviewed(false); }} textareaClassName="text-[15px] leading-relaxed" />
          <Checkbox label="I reviewed this transcript and it matches the reference audio" checked={reviewed} onChange={setReviewed} disabled={!text.trim()} />
          <p className="text-[12px] text-muted">Changing the transcript invalidates the engine's prepared prompt for this reference; it is rebuilt automatically on the next generation.</p>
        </div>
      </Dialog>

      <Dialog
        open={!!trimming}
        onClose={() => setTrimming(null)}
        title="Edit reference trim"
        locked={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setTrimming(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void saveTrim()} loading={busy}>
              Save trim
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Input label="Start (seconds)" type="number" step="0.01" min={0} value={trimStart} onChange={(e) => setTrimStart(e.target.value)} />
            <Input label="End (seconds)" type="number" step="0.01" min={0} value={trimEnd} onChange={(e) => setTrimEnd(e.target.value)} />
          </div>
          <p className="text-[12px] text-muted">Changing the selection marks the transcript as unreviewed. Re-transcribe or confirm the words still match before generating.</p>
        </div>
      </Dialog>

      <DatasetWorkspace voice={voice} open={datasetOpen} onClose={() => setDatasetOpen(false)} onChanged={onChanged} />
    </Card>
  );
}
