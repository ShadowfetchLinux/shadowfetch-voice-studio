import { useEffect, useState } from "react";
import { Check, FileAudio, FolderOpen, Mic } from "lucide-react";
import { api, events } from "@/lib/api";
import type { AudioImportResult, Progress } from "@/lib/protocol";
import { cx, formatBytes, formatDbfs, formatDuration } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/Feedback";
import { toast } from "@/store/appStore";
import { handleError } from "@/store/appStore";
import { Recorder } from "./Recorder";
import type { RecorderTake } from "./recorderMachine";
import type { SourceClip, SourceMode } from "./wizardTypes";

export interface SourceStepProps {
  mode: SourceMode | null;
  onModeChange: (m: SourceMode) => void;
  source: SourceClip | null;
  onSource: (clip: SourceClip) => void;
  /** True while the microphone session is open; mode switching is locked then. */
  recordingActive?: boolean;
  onRecordingActiveChange?: (active: boolean) => void;
}

interface ImportJob {
  path: string;
  name: string;
  progress: Progress | null;
  result: AudioImportResult | null;
  error: string | null;
}

function takeToClip(t: RecorderTake): SourceClip {
  return {
    asset_id: t.asset_id,
    path: t.working_path ?? t.path,
    label: `Take ${t.take_number}`,
    duration_s: t.duration_s,
    sample_rate: t.negotiated.sample_rate,
    stats: t.stats,
    origin: "recording",
  };
}

function importToClip(job: ImportJob, r: AudioImportResult): SourceClip {
  return { asset_id: r.asset_id, path: r.working_path || r.original_path, label: job.name, duration_s: r.probe.duration_s, sample_rate: r.probe.sample_rate, stats: r.stats, origin: "import" };
}

/** Step 1: choose where the reference audio comes from. */
export function SourceStep({ mode, onModeChange, source, onSource, recordingActive = false, onRecordingActiveChange }: SourceStepProps) {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [picking, setPicking] = useState(false);

  const importPaths = async (paths: string[]) => {
    setPicking(true);
    try {
      let selected = source != null;
      for (const path of paths) {
        const name = path.split(/[\\/]/).pop() ?? path;
        setJobs((js) => [...js.filter((j) => j.path !== path), { path, name, progress: null, result: null, error: null }]);
        try {
          const result = await api.audio.import({ path, kind: "reference" }, { onProgress: (p) => setJobs((js) => js.map((j) => (j.path === path ? { ...j, progress: p } : j))) });
          setJobs((js) => js.map((j) => (j.path === path ? { ...j, result, progress: null } : j)));
          if (!selected) {
            selected = true;
            onSource(importToClip({ path, name, progress: null, result, error: null }, result));
          }
        } catch (err) {
          const we = handleError(err, `Could not import ${name}`);
          setJobs((js) => js.map((j) => (j.path === path ? { ...j, error: `${we.message} (${we.code})`, progress: null } : j)));
        }
      }
    } finally {
      setPicking(false);
    }
  };

  const pickFiles = async () => {
    try {
      const paths = await api.shell.pickAudioFiles();
      if (paths.length) await importPaths(paths);
    } catch (err) {
      handleError(err, "File dialog failed");
    }
  };

  // Drag-and-drop onto the window: only WAV/MP3/FLAC files; others are ignored with a notice.
  useEffect(() => {
    if (mode !== "import" || recordingActive) return;
    return events.onFileDrop((paths) => {
      const audio = paths.filter((p) => /\.(wav|mp3|flac)$/i.test(p));
      if (!audio.length) {
        toast.info("Only WAV, MP3 or FLAC files can be imported.");
        return;
      }
      void importPaths(audio);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, recordingActive, source]);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3" role="radiogroup" aria-label="Audio source">
        <ModeCard active={mode === "record"} icon={<Mic />} title="Record with microphone" text="Read a short guided script; the worker writes a 24-bit WAV while you speak." onClick={() => onModeChange("record")} disabled={recordingActive} />
        <ModeCard active={mode === "import"} icon={<FileAudio />} title="Import audio (WAV/MP3/FLAC)" text="Use an existing clean recording. The original is copied unchanged." onClick={() => onModeChange("import")} disabled={recordingActive} />
      </div>

      {mode === "record" && <Recorder onUseTake={(t) => onSource(takeToClip(t))} activeAssetId={source?.origin === "recording" ? source.asset_id : null} onActiveChange={onRecordingActiveChange} />}

      {mode === "import" && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <Button variant="primary" icon={<FolderOpen />} loading={picking} onClick={() => void pickFiles()}>
              Choose audio files…
            </Button>
            <span className="text-[12.5px] text-muted">WAV, MP3 or FLAC, up to 2 GB. Use the dialog or drop files anywhere on the window.</span>
          </div>
          {jobs.length > 0 && (
            <ul className="flex flex-col gap-2" aria-label="Imported files">
              {jobs.map((j) => {
                const r = j.result;
                const isActive = r != null && source?.asset_id === r.asset_id;
                return (
                  <li key={j.path} className={cx("rounded-[var(--radius-control)] border px-3 py-2 flex flex-col gap-2", isActive ? "border-accent bg-accent-soft/40" : "border-border")}>
                    <div className="flex items-center gap-3 flex-wrap">
                      <FileAudio className="size-4 text-muted shrink-0" />
                      <span className="text-sm font-medium truncate max-w-[40ch]" title={j.path}>
                        {j.name}
                      </span>
                      {r && (
                        <span className="text-[12.5px] text-muted tabular-nums">
                          {formatDuration(r.probe.duration_s)} · {r.probe.sample_rate} Hz · {r.probe.channels === 1 ? "mono" : `${r.probe.channels} ch`} · {r.probe.codec} · {formatBytes(r.probe.size_bytes)} · peak {formatDbfs(r.stats.peak_dbfs)}
                        </span>
                      )}
                      <span className="flex-1" />
                      {r && (
                        <Button size="sm" variant={isActive ? "secondary" : "primary"} icon={isActive ? <Check /> : undefined} onClick={() => onSource(importToClip(j, r))}>
                          {isActive ? "Selected" : "Use this file"}
                        </Button>
                      )}
                    </div>
                    {j.progress && (
                      <ProgressBar
                        size="sm"
                        label={j.progress.message}
                        current={j.progress.detail?.bytes_done ?? j.progress.current ?? null}
                        total={j.progress.detail?.bytes_total ?? j.progress.total ?? null}
                        caption={j.progress.detail?.bytes_total ? `${formatBytes(j.progress.detail.bytes_done)} of ${formatBytes(j.progress.detail.bytes_total)}` : undefined}
                      />
                    )}
                    {j.error && (
                      <p role="alert" className="text-[12.5px] text-danger">
                        {j.error}
                      </p>
                    )}
                    {r?.stats.warnings.length ? (
                      <ul className="text-[12px] text-warn pl-7">
                        {r.stats.warnings.map((w) => (
                          <li key={w.code}>{w.message} (heuristic)</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {source && (
        <p className="text-[13px] text-success flex items-center gap-1.5">
          <Check className="size-4" /> Using {source.label} ({formatDuration(source.duration_s)}). Continue to review and trim it.
        </p>
      )}
    </div>
  );
}

function ModeCard({ active, icon, title, text, onClick, disabled }: { active: boolean; icon: React.ReactNode; title: string; text: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      disabled={disabled && !active}
      className={cx("flex items-start gap-3 p-4 rounded-[var(--radius-panel)] border text-left min-h-[88px] transition-colors disabled:opacity-60 disabled:cursor-not-allowed", active ? "border-accent bg-accent-soft/50" : "border-border hover:border-border-strong bg-panel")}
    >
      <span className={cx("inline-flex items-center justify-center size-10 rounded-[8px] shrink-0 [&>svg]:size-5", active ? "bg-accent text-white" : "bg-accent-soft text-accent")}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-[12.5px] text-muted mt-0.5">{text}</span>
      </span>
    </button>
  );
}
