import { useEffect, useReducer, useRef, useState } from "react";
import { Captions, Pause, Play, Undo2 } from "lucide-react";
import { api, type RequestPromise } from "@/lib/api";
import type { PeakPair, ReferenceRequirements, TranscribeResult } from "@/lib/protocol";
import { cx } from "@/lib/format";
import { friendlyError, logWorkerError } from "@/lib/friendlyErrors";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Toggle";
import { Collapsible } from "@/components/ui/Feedback";
import { Spinner } from "@/components/ui/Spinner";
import { Waveform, usePlayer, type Selection } from "@/components/audio";
import { useAppStore } from "@/store/appStore";
import { ensureModels } from "@/store/modelSetup";
import { isTranscriptStale, selectionKey, transcriptReducer, type TranscriptState } from "../transcriptState";
import { isProcessingActive, toPreviewProcessing, type ProcessingOptions } from "../processing";

export interface SampleEditResult {
  selection: Selection;
  /** `reviewed` is true only when the words were on screen when the user accepted them. */
  transcript: TranscriptState;
  processing: ProcessingOptions;
  /** Confidence of a transcription made in the editor (null when the words were typed or kept). */
  confidence: number | null;
}

export interface SampleEditorProps {
  path: string;
  assetId: string;
  initialSelection: Selection;
  /** Words already known for `initialSelection` (bound to it). */
  initialTranscript?: Omit<TranscriptState, "boundKey" | "reviewed"> | null;
  initialProcessing: ProcessingOptions;
  reference: ReferenceRequirements | null;
  language: string;
  /** Short guidance above the waveform. */
  intro?: string;
  submitLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (r: SampleEditResult) => void;
}

/** Plain-language check of the selected length against the voice engine's limits. */
export function plainVerdict(sel: Selection | null, ref: ReferenceRequirements | null): { level: "ok" | "warn" | "error"; text: string } {
  if (!sel) return { level: "error", text: "Drag across the waveform to choose a part." };
  const d = sel.end - sel.start;
  const secs = `${d.toFixed(1)} seconds selected`;
  if (!ref) return { level: d >= 3 ? "ok" : "error", text: secs };
  if (d <= ref.min_seconds) return { level: "error", text: `${secs} — too short. Choose more than ${ref.min_seconds} seconds.` };
  if (d > ref.max_seconds) return { level: "error", text: `${secs} — too long. Choose at most ${ref.max_seconds} seconds.` };
  const [lo, hi] = ref.recommended_seconds;
  if (hi > 0 && (d < lo || d > hi)) return { level: "warn", text: `${secs}. That works; ${lo}–${hi} seconds of clear speech clones best.` };
  return { level: "ok", text: `${secs} — a good length.` };
}

/**
 * Edit Sample: choose the part of the recording the voice is cloned from, check the words spoken in it, and
 * optionally clean it up. The recording itself is never modified — trim and clean-up apply to a derived copy.
 */
export function SampleEditor(props: SampleEditorProps) {
  const { path, assetId, reference, language, intro, submitLabel, busy, onCancel, onSubmit } = props;
  const settings = useAppStore((s) => s.settings);
  const [peaks, setPeaks] = useState<{ peaks: PeakPair[]; duration: number } | null>(null);
  const [peaksError, setPeaksError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(props.initialSelection);
  const [history, setHistory] = useState<Selection[]>([]);
  const initialKey = selectionKey(path, props.initialSelection);
  const [transcript, dispatch] = useReducer(
    transcriptReducer,
    props.initialTranscript?.text
      ? { ...props.initialTranscript, boundKey: initialKey, reviewed: false }
      : { text: "", source: null, boundKey: null, reviewed: false, asrModel: null, language: null },
  );
  const [processing, setProcessing] = useState<ProcessingOptions>(props.initialProcessing);
  const [asrBusy, setAsrBusy] = useState(false);
  const [asrError, setAsrError] = useState<string | null>(null);
  const asrReq = useRef<RequestPromise<TranscribeResult> | null>(null);
  const lastConfidence = useRef<number | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const key = selectionKey(path, selection);
  const stale = isTranscriptStale(transcript, key);
  const verdict = plainVerdict(selection, reference);
  const player = usePlayer({ path: preview ?? path, selection: preview ? null : selection, restrictToSelection: !preview });

  useEffect(() => {
    let alive = true;
    api.audio
      .peaks({ path, points: 2000 })
      .then((r) => alive && setPeaks({ peaks: r.peaks, duration: r.duration_s }))
      .catch((err) => alive && setPeaksError(friendlyError(err, "import").message));
    return () => {
      alive = false;
      void asrReq.current?.cancel();
    };
  }, [path]);

  useEffect(() => setPreview(null), [selection, processing]);

  const changeSelection = (sel: Selection | null) => {
    if (!sel) return;
    setHistory((h) => [...h, selection]);
    setSelection(sel);
    dispatch({ type: "selectionChanged", key: selectionKey(path, sel) });
  };
  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setSelection(prev);
    dispatch({ type: "selectionChanged", key: selectionKey(path, prev) });
  };

  /** Transcribe the current selection; returns the new transcript state (null when it failed or was cancelled). */
  const transcribe = async (): Promise<TranscriptState | null> => {
    setAsrError(null);
    if (!(await ensureModels("clone"))) return null;
    setAsrBusy(true);
    const req = api.transcribe.run({ path, start_s: selection.start, end_s: selection.end, model_id: settings?.asr_model, device: settings?.asr_device, language });
    asrReq.current = req;
    try {
      const r = await req;
      const next: TranscriptState = { text: r.text.trim(), source: "asr", boundKey: key, reviewed: false, asrModel: r.model_id, language: r.language };
      lastConfidence.current = r.confidence ?? null;
      dispatch({ type: "transcribed", text: next.text, key, model: r.model_id, language: r.language });
      return next;
    } catch (err) {
      logWorkerError("transcribe", err);
      const f = friendlyError(err, "clone");
      if (!f.code.includes("CANCELLED")) setAsrError(f.message);
      return null;
    } finally {
      asrReq.current = null;
      setAsrBusy(false);
    }
  };

  const submit = async () => {
    let t: TranscriptState | null = transcript;
    // words filled in right now were never on screen: they are submitted as not reviewed by a person
    let seen = true;
    if (!t.text.trim() || (stale && t.source !== "edited")) {
      t = await transcribe();
      seen = false;
    } else if (stale) return; // typed words + a different selection: the user decides (buttons below)
    if (!t || !t.text.trim()) return;
    onSubmit({ selection, transcript: { ...t, boundKey: key, reviewed: seen }, processing, confidence: t.source === "asr" ? lastConfidence.current : null });
  };

  const runPreview = async () => {
    setPreviewBusy(true);
    try {
      const paths = await api.shell.appPaths().catch(() => null);
      const out = paths ? `${paths.cache}/tmp/sfvs-preview-${assetId}-${selection.start.toFixed(3)}-${selection.end.toFixed(3)}.wav` : undefined;
      const cut = await api.audio.trim({ path, start_s: selection.start, end_s: selection.end, out_path: out });
      const r = await api.audio.previewProcessing({ path: cut.path, processing: toPreviewProcessing(processing) });
      setPreview(r.path);
    } catch (err) {
      logWorkerError("preview", err);
    } finally {
      setPreviewBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {intro && <p className="text-[14px]">{intro}</p>}
      {peaksError ? (
        <p role="alert" className="text-sm text-danger">
          {peaksError}
        </p>
      ) : !peaks ? (
        <div className="flex items-center gap-2 text-muted text-sm h-[140px]">
          <Spinner /> Drawing the waveform…
        </div>
      ) : (
        <Waveform peaks={peaks.peaks} duration={peaks.duration} height={140} currentTime={player.currentTime} onSeek={player.seek} selectable selection={selection} onSelectionChange={changeSelection} minSelection={0.5} label="Recording — drag to choose the part to use" />
      )}
      <div className="flex items-center gap-3 flex-wrap">
        <Button size="sm" variant="soft" icon={player.playing ? <Pause /> : <Play />} onClick={() => (player.playing ? player.pause() : void player.playSelection())} disabled={!player.ready && !player.playing}>
          {player.playing ? "Pause" : preview ? "Play cleaned-up part" : "Play selected part"}
        </Button>
        <Button size="sm" variant="ghost" icon={<Undo2 />} disabled={history.length === 0} onClick={undo}>
          Undo
        </Button>
        <span className={cx("text-[13px]", verdict.level === "error" ? "text-danger" : verdict.level === "warn" ? "text-warn" : "text-muted")} data-testid="trim-verdict">
          {verdict.text}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="sample-words" className="text-[13px] font-medium">
            Words spoken in this part
          </label>
          <Button size="sm" variant="ghost" icon={<Captions />} loading={asrBusy} onClick={() => void transcribe()}>
            {transcript.text ? "Fill in again" : "Fill in automatically"}
          </Button>
        </div>
        <textarea
          id="sample-words"
          rows={4}
          className="field-input py-2.5 text-[15px] leading-relaxed"
          value={transcript.text}
          onChange={(e) => dispatch({ type: "edit", text: e.target.value, key })}
          placeholder="Exactly what is said in the selected part. Leave empty to fill it in automatically."
        />
        {stale && transcript.text.trim() && (
          <div className="flex items-center gap-3 flex-wrap text-[13px] text-warn">
            <span>The selected part changed since these words were written.</span>
            {transcript.source === "edited" && (
              <button type="button" className="font-medium text-accent hover:underline" onClick={() => dispatch({ type: "confirmMatches", key })}>
                The words still match
              </button>
            )}
          </div>
        )}
        {asrError && (
          <p role="alert" className="text-[13px] text-danger">
            {asrError}
          </p>
        )}
        <p className="text-[12px] text-muted">The voice is cloned from the audio and these exact words, so fix anything that was misheard.</p>
      </div>

      <Collapsible title="Clean up the sample (optional)" description={isProcessingActive(processing) ? "On — applied to a copy." : "Off. Your recording is never changed."}>
        <div className="flex flex-col gap-3 pt-2">
          <Checkbox label="Even out the volume" description="Makes a quiet or uneven sample louder." checked={processing.normalize} onChange={(v) => setProcessing({ ...processing, normalize: v })} />
          <Checkbox label="Trim silence at the edges" checked={processing.trimSilence} onChange={(v) => setProcessing({ ...processing, trimSilence: v })} />
          <Checkbox label="Remove low rumble" description="Helps with fans, traffic or desk bumps." checked={processing.highpass} onChange={(v) => setProcessing({ ...processing, highpass: v })} />
          <div>
            <Button size="sm" loading={previewBusy} disabled={!isProcessingActive(processing)} onClick={() => void runPreview()}>
              Hear the cleaned-up part
            </Button>
          </div>
        </div>
      </Collapsible>

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" loading={busy || asrBusy} disabled={verdict.level === "error" || (stale && transcript.source === "edited" && !!transcript.text.trim())} onClick={() => void submit()}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
