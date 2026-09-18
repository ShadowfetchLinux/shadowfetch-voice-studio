import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, FolderOpen } from "lucide-react";
import { api } from "@/lib/api";
import type { ExportFormat, ExportRenderParams, ExportRenderResult, LoudnessTarget, Progress, Project } from "@/lib/protocol";
import { WorkerError } from "@/lib/protocol";
import { formatBytes, formatDuration } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Select } from "@/components/ui/Field";
import { Checkbox } from "@/components/ui/Toggle";
import { ProgressBar } from "@/components/ui/Feedback";
import { handleError, toast, useAppStore } from "@/store/appStore";

export interface ExportDialogProps {
  project: Project | null;
  onClose: () => void;
  /** Called after a successful render so the owner can refresh the exports list. */
  onExported?: (r: ExportRenderResult) => void;
}

type BitDepth = "16" | "24" | "32f";
type RateChoice = "native" | "48000";
type Mp3Mode = "cbr" | "vbr";

/** Export… dialog: format/quality options → pick_save_path → export.render with progress → measured result. */
export function ExportDialog({ project, onClose, onExported }: ExportDialogProps) {
  const settings = useAppStore((s) => s.settings);
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [bitDepth, setBitDepth] = useState<BitDepth>("24");
  const [rate, setRate] = useState<RateChoice>("native");
  const [mp3Mode, setMp3Mode] = useState<Mp3Mode>("cbr");
  const [bitrate, setBitrate] = useState<"128" | "192" | "256" | "320">("192");
  const [vbr, setVbr] = useState("2");
  const [loudness, setLoudness] = useState<string>("");
  const [aiMeta, setAiMeta] = useState(true);
  const [targets, setTargets] = useState<LoudnessTarget[] | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<ExportRenderResult | null>(null);

  // defaults from settings, re-applied per opened project
  useEffect(() => {
    if (!project) return;
    setResult(null);
    setProgress(null);
    const f = settings?.export_default_format;
    setFormat(f === "flac" || f === "mp3" ? f : "wav");
    const d = settings?.export_wav_bit_depth;
    setBitDepth(d === 16 ? "16" : d === 32 ? "32f" : "24");
    const br = settings?.export_mp3_bitrate_kbps;
    setBitrate(br === 128 || br === 256 || br === 320 ? String(br) as "128" | "256" | "320" : "192");
    setAiMeta(settings?.export_ai_metadata ?? true);
    setLoudness("");
    api.export
      .loudnessTargets()
      .then((r) => {
        setTargets(r.targets);
        setTargetsError(null);
      })
      .catch((err) => {
        setTargets([]);
        setTargetsError(WorkerError.from(err).message);
      });
  }, [project, settings]);

  const target = useMemo(() => targets?.find((t) => t.id === loudness) ?? null, [targets, loudness]);

  const run = async () => {
    if (!project) return;
    setBusy(true);
    try {
      const out = await api.shell.pickSavePath(project.name, format);
      if (!out) return;
      const params: ExportRenderParams = { project_id: project.id, format, out_path: out, sample_rate: rate === "48000" ? 48000 : "native", ai_metadata: aiMeta };
      if (format === "wav") params.wav_bit_depth = bitDepth === "16" ? 16 : bitDepth === "32f" ? "32f" : 24;
      if (format === "flac") params.wav_bit_depth = bitDepth === "16" ? 16 : 24;
      if (format === "mp3") {
        if (mp3Mode === "cbr") params.mp3_bitrate_kbps = Number(bitrate) as 128 | 192 | 256 | 320;
        else params.mp3_vbr_quality = Number(vbr);
      }
      if (target) params.loudness = { target_id: target.id };
      setProgress(null);
      const r = await api.export.render(params, { onProgress: setProgress });
      setResult(r);
      onExported?.(r);
      toast.success("Export finished", r.path);
    } catch (err) {
      handleError(err, "Export failed");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <Dialog
      open={!!project}
      onClose={onClose}
      title={project ? `Export "${project.name}"` : "Export"}
      description={project?.master_path ? "Renders a copy of the master with ffmpeg; the master itself is never modified." : "This project has no master yet."}
      locked={busy}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {result ? "Done" : "Cancel"}
          </Button>
          <Button variant="primary" onClick={() => void run()} loading={busy} disabled={!project?.master_path}>
            {result ? "Export again…" : "Choose file and export…"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Select label="Format" value={format} options={[{ value: "wav", label: "WAV (PCM)" }, { value: "flac", label: "FLAC (lossless)" }, { value: "mp3", label: "MP3" }]} onChange={(e) => setFormat(e.target.value as ExportFormat)} disabled={busy} />
          {format !== "mp3" && (
            <Select label="Bit depth" value={format === "flac" && bitDepth === "32f" ? "24" : bitDepth} options={format === "wav" ? [{ value: "16", label: "16-bit" }, { value: "24", label: "24-bit" }, { value: "32f", label: "32-bit float" }] : [{ value: "16", label: "16-bit" }, { value: "24", label: "24-bit" }]} onChange={(e) => setBitDepth(e.target.value as BitDepth)} disabled={busy} />
          )}
          {format === "mp3" && (
            <Select label="MP3 encoding" value={mp3Mode} options={[{ value: "cbr", label: "Constant bitrate" }, { value: "vbr", label: "Variable bitrate (quality)" }]} onChange={(e) => setMp3Mode(e.target.value as Mp3Mode)} disabled={busy} />
          )}
          {format === "mp3" && mp3Mode === "cbr" && (
            <Select label="Bitrate" value={bitrate} options={["128", "192", "256", "320"].map((b) => ({ value: b, label: `${b} kbit/s` }))} onChange={(e) => setBitrate(e.target.value as "128" | "192" | "256" | "320")} disabled={busy} />
          )}
          {format === "mp3" && mp3Mode === "vbr" && (
            <Select label="VBR quality" value={vbr} options={Array.from({ length: 10 }, (_, i) => ({ value: String(i), label: `${i}${i === 0 ? " (best)" : i === 9 ? " (smallest)" : ""}` }))} onChange={(e) => setVbr(e.target.value)} disabled={busy} hint="LAME -V scale: 0 is the highest quality." />
          )}
          <Select
            label="Sample rate"
            value={rate}
            options={[{ value: "native", label: `Native${project?.master?.sample_rate ? ` (${project.master.sample_rate} Hz)` : ""}` }, { value: "48000", label: "48 000 Hz" }]}
            onChange={(e) => setRate(e.target.value as RateChoice)}
            disabled={busy}
            hint={rate === "48000" ? "Upsampling adds no detail; it only changes the container rate for tools that expect 48 kHz." : undefined}
          />
        </div>
        <Select
          label="Loudness normalization"
          value={loudness}
          placeholder={targets == null ? "Loading targets…" : targets.length === 0 ? "No targets provided by the worker" : "Off — keep the master's level"}
          options={(targets ?? []).map((t) => ({ value: t.id, label: t.label }))}
          onChange={(e) => setLoudness(e.target.value)}
          disabled={busy || !targets?.length}
          error={targetsError ?? undefined}
          hint={target ? `${target.description} Two-pass ffmpeg loudnorm; the result is measured with ebur128.` : "Optional two-pass normalization to a named delivery level."}
        />
        <Checkbox label="Embed AI-generated metadata" description="Writes a tag stating the audio was generated with a local TTS engine." checked={aiMeta} onChange={setAiMeta} disabled={busy} />

        {busy && <ProgressBar label={progress?.message ?? "Rendering…"} current={progress?.current} total={progress?.total} />}

        {result && (
          <div className="rounded-[var(--radius-control)] border border-success/40 bg-success-soft px-4 py-3 text-sm flex flex-col gap-2" role="status">
            <p className="flex items-center gap-2 font-medium text-success">
              <CheckCircle2 className="size-4" /> Written {formatBytes(result.size_bytes)} to {result.path}
            </p>
            <p className="text-[12.5px] text-text tabular-nums">
              {result.probe.codec} · {result.probe.sample_rate} Hz · {result.probe.channels === 1 ? "mono" : `${result.probe.channels} ch`}
              {result.probe.bit_depth ? ` · ${result.probe.bit_depth}-bit` : ""} · {formatDuration(result.probe.duration_s)}
              {result.loudness_measured && ` · measured ${result.loudness_measured.integrated_lufs.toFixed(1)} LUFS, true peak ${result.loudness_measured.true_peak_dbtp.toFixed(1)} dBTP, LRA ${result.loudness_measured.lra.toFixed(1)} LU`}
            </p>
            {result.collision_renamed && <p className="text-[12.5px] text-warn">A file with that name existed, so the export was renamed.</p>}
            <div>
              <Button size="sm" icon={<FolderOpen />} onClick={() => void api.shell.revealPath(result.path).catch((err) => handleError(err, "Could not open the folder"))}>
                Open containing folder
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
