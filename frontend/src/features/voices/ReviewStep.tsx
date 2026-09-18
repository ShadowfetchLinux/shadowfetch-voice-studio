import { useEffect, useRef, useState } from "react";
import { FlaskConical, Play, Undo2 } from "lucide-react";
import { api } from "@/lib/api";
import type { AudioStats, Capabilities, PeakPair } from "@/lib/protocol";
import { WorkerError } from "@/lib/protocol";
import { cx, formatDbfs, formatDuration } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Toggle";
import { Slider } from "@/components/ui/Slider";
import { Collapsible, StatusPill } from "@/components/ui/Feedback";
import { Spinner } from "@/components/ui/Spinner";
import { PlayerBar, Waveform, usePlayer, type Selection } from "@/components/audio";
import { handleError } from "@/store/appStore";
import { suggestSelection, validateSelection, type TrimVerdict } from "./trimValidation";
import { isProcessingActive, toPreviewProcessing, type ProcessingOptions } from "./processing";
import type { SourceClip } from "./wizardTypes";

export interface ReviewStepProps {
  source: SourceClip;
  caps: Capabilities | null;
  capsError: string | null;
  selection: Selection | null;
  onSelectionChange: (sel: Selection | null) => void;
  processing: ProcessingOptions;
  onProcessingChange: (p: ProcessingOptions) => void;
}

const VERDICT_TONE = { ok: "success", warn: "warn", error: "danger" } as const;

/** Step 2: waveform with trim handles validated live against the engine's reference limits, stats, optional processing preview. */
export function ReviewStep({ source, caps, capsError, selection, onSelectionChange, processing, onProcessingChange }: ReviewStepProps) {
  const [peaks, setPeaks] = useState<{ peaks: PeakPair[]; duration: number } | null>(null);
  const [peaksError, setPeaksError] = useState<string | null>(null);
  const [stats, setStats] = useState<AudioStats | null>(null);
  const [statsBusy, setStatsBusy] = useState(false);
  const [preview, setPreview] = useState<{ path: string; duration_s?: number } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const ref = caps?.reference ?? null;
  const verdict: TrimVerdict = validateSelection(selection, ref);

  // peaks for the file
  useEffect(() => {
    let alive = true;
    setPeaks(null);
    setPeaksError(null);
    api.audio
      .peaks({ path: source.path, points: 2000 })
      .then((r) => alive && setPeaks({ peaks: r.peaks, duration: r.duration_s }))
      .catch((err) => alive && setPeaksError(WorkerError.from(err).message));
    return () => {
      alive = false;
    };
  }, [source.path]);

  // suggest a selection once we know the duration and there is none yet
  const suggestedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!peaks || selection || suggestedFor.current === source.path) return;
    suggestedFor.current = source.path;
    onSelectionChange(suggestSelection(peaks.duration, ref, source.stats?.leading_silence_s ?? 0));
  }, [peaks, selection, ref, source, onSelectionChange]);

  // measured stats of the selection (debounced while dragging)
  useEffect(() => {
    if (!selection) return;
    let alive = true;
    setStatsBusy(true);
    const t = window.setTimeout(() => {
      api.audio
        .stats({ path: source.path, start_s: selection.start, end_s: selection.end })
        .then((s) => alive && setStats(s))
        .catch(() => alive && setStats(null))
        .finally(() => alive && setStatsBusy(false));
    }, 350);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [source.path, selection]);

  // a processing preview is bound to the selection + options it was made for
  useEffect(() => setPreview(null), [selection, processing]);

  const player = usePlayer({ path: preview?.path ?? source.path, selection: preview ? null : selection, restrictToSelection: !preview });

  const runPreview = async () => {
    if (!selection) return;
    setPreviewBusy(true);
    try {
      // 1) cut the selection into the cache (never touches the source), 2) apply the processing to that copy
      let cutPath: string | undefined;
      try {
        const paths = await api.shell.appPaths();
        cutPath = `${paths.cache}/tmp/sfvs-preview-${source.asset_id}-${selection.start.toFixed(3)}-${selection.end.toFixed(3)}.wav`;
      } catch {
        cutPath = undefined; // the worker picks a default output path
      }
      const cut = await api.audio.trim({ path: source.path, start_s: selection.start, end_s: selection.end, out_path: cutPath });
      const r = (await api.audio.previewProcessing({ path: cut.path, processing: toPreviewProcessing(processing) })) as { path: string; duration_s?: number };
      setPreview(r);
    } catch (err) {
      handleError(err, "Processing preview failed");
    } finally {
      setPreviewBusy(false);
    }
  };

  const update = (patch: Partial<ProcessingOptions>) => onProcessingChange({ ...processing, ...patch });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap text-[13px]">
        <span className="text-muted">
          {caps && ref ? (
            <>
              <strong className="text-text">{caps.name}</strong> needs {ref.min_seconds}–{ref.max_seconds} s of reference audio (recommended {ref.recommended_seconds[0]}–{ref.recommended_seconds[1]} s, {ref.sample_rate} Hz {ref.channels === 1 ? "mono" : `${ref.channels} ch`}).
            </>
          ) : capsError ? (
            <span className="text-warn">Engine limits unavailable: {capsError}</span>
          ) : (
            "Loading engine limits…"
          )}
        </span>
        <StatusPill tone={VERDICT_TONE[verdict.level]} dot data-testid="trim-verdict">
          {verdict.message}
        </StatusPill>
      </div>

      {peaksError ? (
        <p role="alert" className="text-sm text-danger">
          Waveform unavailable: {peaksError}
        </p>
      ) : !peaks ? (
        <div className="flex items-center gap-2 text-muted text-sm h-[160px]">
          <Spinner /> Computing waveform…
        </div>
      ) : (
        <>
          <Waveform peaks={peaks.peaks} duration={peaks.duration} currentTime={player.currentTime} onSeek={player.seek} selectable selection={selection} onSelectionChange={onSelectionChange} minSelection={0.5} label={`Waveform of ${source.label}`} />
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="primary" icon={<Play />} onClick={() => void player.playSelection()} disabled={!selection || !!preview}>
              Play selection
            </Button>
            <PlayerBar player={player} hasSelection={!!selection && !preview} compact className="flex-1 min-w-[320px]" />
          </div>
        </>
      )}

      <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-[12.5px]" aria-label="Selection statistics">
        <Stat label="Selection" value={selection ? formatDuration(selection.end - selection.start) : "—"} />
        <Stat label="Sample rate" value={stats ? `${stats.sample_rate} Hz` : source.sample_rate ? `${source.sample_rate} Hz` : "—"} />
        <Stat label="Peak" value={stats ? formatDbfs(stats.peak_dbfs) : "—"} busy={statsBusy} />
        <Stat label="RMS" value={stats ? formatDbfs(stats.rms_dbfs) : "—"} busy={statsBusy} />
      </dl>
      {stats && (stats.warnings.length > 0 || stats.clipping_samples > 0) && (
        <ul className="text-[12.5px] text-warn flex flex-col gap-0.5" aria-label="Heuristic warnings">
          {stats.clipping_samples > 0 && !stats.warnings.some((w) => w.code === "CLIPPING") && <li>{stats.clipping_samples} samples at full scale in the selection (heuristic).</li>}
          {stats.warnings.map((w) => (
            <li key={w.code}>
              {w.message} <span className="text-muted">(heuristic)</span>
            </li>
          ))}
        </ul>
      )}

      <Collapsible title="Processing (optional)" description={isProcessingActive(processing) ? "Enabled — preview before saving." : "Off. Applied to a copy; the recording is never modified."}>
        <div className="flex flex-col gap-3 pt-2">
          <Checkbox label="Normalize peak" description="Scale the clip so its loudest sample reaches the target level." checked={processing.normalize} onChange={(v) => update({ normalize: v })} />
          {processing.normalize && <Slider label="Target peak" value={processing.normalizeDbfs} onChange={(v) => update({ normalizeDbfs: v })} min={-12} max={0} step={0.5} defaultValue={-3} format={(v) => `${v.toFixed(1)} dBFS`} />}
          <Checkbox label="Trim silence" description="Cut leading and trailing silence (conservative, keeps a short pad)." checked={processing.trimSilence} onChange={(v) => update({ trimSilence: v })} />
          <Checkbox label="High-pass filter" description="Remove rumble below the cutoff." checked={processing.highpass} onChange={(v) => update({ highpass: v })} />
          {processing.highpass && <Slider label="Cutoff" value={processing.highpassHz} onChange={(v) => update({ highpassHz: v })} min={40} max={200} step={5} defaultValue={80} format={(v) => `${v.toFixed(0)} Hz`} />}
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" icon={<FlaskConical />} loading={previewBusy} disabled={!selection || !isProcessingActive(processing)} onClick={() => void runPreview()}>
              Preview processed selection
            </Button>
            <Button size="sm" variant="ghost" icon={<Undo2 />} disabled={!preview} onClick={() => setPreview(null)}>
              Revert to original
            </Button>
            {preview && (
              <StatusPill tone="accent" dot>
                Playing the processed copy{preview.duration_s ? ` (${formatDuration(preview.duration_s)})` : ""}
              </StatusPill>
            )}
          </div>
          <p className="text-[12px] text-muted">
            Saved with the voice: peak normalization is applied when the engine reference is prepared. Trim silence and high-pass are preview-only in this worker version (they are recorded with the reference but not yet applied to the derived file).
          </p>
        </div>
      </Collapsible>
    </div>
  );
}

function Stat({ label, value, busy }: { label: string; value: string; busy?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className={cx("tabular-nums", busy && "opacity-60")}>{value}</dd>
    </div>
  );
}
