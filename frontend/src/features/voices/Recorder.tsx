import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Circle, Mic, Pause, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { Device, RecordScript } from "@/lib/protocol";
import { WorkerError } from "@/lib/protocol";
import { cx, formatDbfs, formatDuration, formatTime } from "@/lib/format";
import { Button, IconButton } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { StatusPill } from "@/components/ui/Feedback";
import { Meter } from "@/components/ui/Meter";
import { PlayerBar, usePlayer } from "@/components/audio";
import { useAppStore } from "@/store/appStore";
import { describePhase, type RecorderTake } from "./recorderMachine";
import { useRecorder } from "./useRecorder";
import { Teleprompter } from "./Teleprompter";

export interface RecorderProps {
  /** Called when the user picks a take to continue with. */
  onUseTake: (take: RecorderTake) => void;
  /** Asset id of the take currently used by the workflow (highlighted). */
  activeAssetId?: string | null;
  /** Reports whether a session is open (the owner should not unmount the recorder while true). */
  onActiveChange?: (active: boolean) => void;
}

function deviceLabel(d: Device & { backend?: string }): string {
  return `${d.name} (${d.hostapi}${d.default_samplerate ? `, ${Math.round(d.default_samplerate)} Hz` : ""})`;
}

type DevicesResult = { inputs: Array<Device & { backend?: string }>; default_input: number | null; backend?: string; notes?: string[] };

/** Microphone recorder: device pick, guided script, live meter, transport, negotiated settings, takes. */
export function Recorder({ onUseTake, activeAssetId, onActiveChange }: RecorderProps) {
  const settings = useAppStore((s) => s.settings);
  const [devices, setDevices] = useState<DevicesResult | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [deviceIndex, setDeviceIndex] = useState<number | null>(settings?.record_device_index ?? null);
  const [scripts, setScripts] = useState<RecordScript[]>([]);
  const [scriptsStatus, setScriptsStatus] = useState<string | null>("Loading scripts…");
  const [scriptId, setScriptId] = useState<string | null>(null);
  const [previewTake, setPreviewTake] = useState<RecorderTake | null>(null);

  const recorder = useRecorder({ deviceIndex, scriptId });
  const { state } = recorder;
  const phase = describePhase(state.phase);
  const active = state.phase === "recording" || state.phase === "paused" || state.phase === "starting" || state.phase === "stopping" || (state.phase === "error" && !!state.sessionId);
  useEffect(() => onActiveChange?.(active), [active, onActiveChange]);

  const loadDevices = async () => {
    setDevicesError(null);
    try {
      const r = (await api.record.devices()) as DevicesResult;
      setDevices(r);
      if (deviceIndex != null && !r.inputs.some((d) => d.index === deviceIndex)) setDeviceIndex(null);
    } catch (err) {
      setDevices({ inputs: [], default_input: null });
      setDevicesError(WorkerError.from(err).message);
    }
  };

  useEffect(() => {
    void loadDevices();
    api.record
      .scripts()
      .then((r) => {
        setScripts(r.scripts);
        setScriptsStatus(r.scripts.length === 0 ? "No guided scripts were provided by the worker." : null);
        if (r.scripts[0]) setScriptId(r.scripts[0].id);
      })
      .catch((err) => setScriptsStatus(`Scripts unavailable: ${WorkerError.from(err).message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const player = usePlayer({ path: previewTake?.path ?? null });
  useEffect(() => {
    if (previewTake && player.ready) void player.play();
    // play once per loaded take
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewTake, player.ready]);
  const inputs = devices?.inputs ?? [];
  const defaultName = useMemo(() => inputs.find((d) => d.index === devices?.default_input)?.name, [inputs, devices]);
  const neg = state.negotiated;
  const err = state.error;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
        <Select
          label="Input device"
          value={deviceIndex == null ? "" : String(deviceIndex)}
          placeholder={inputs.length ? `System default${defaultName ? ` (${defaultName})` : ""}` : devices ? "No input devices found" : "Scanning…"}
          options={inputs.map((d) => ({ value: String(d.index), label: deviceLabel(d) }))}
          onChange={(e) => setDeviceIndex(e.target.value === "" ? null : Number(e.target.value))}
          disabled={active || inputs.length === 0}
          error={devicesError ?? undefined}
          hint={[
            devices?.notes?.length ? devices.notes.join(" ") : devices?.backend ? `Capture backend: ${devices.backend}.` : null,
            settings?.monitor_input ? "Input monitoring is on — use headphones to avoid feedback." : "Hear yourself while recording from Settings → Audio devices (headphones recommended).",
          ]
            .filter(Boolean)
            .join(" ")}
        />
        <Button variant="ghost" icon={<RefreshCw />} onClick={() => void loadDevices()} disabled={active} className="mb-[22px] md:mb-0">
          Rescan
        </Button>
      </div>

      <Teleprompter scripts={scripts} selectedId={scriptId} onSelect={setScriptId} status={scriptsStatus} disabled={active} />

      <div className="rounded-[var(--radius-panel)] border border-border bg-panel-alt p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <StatusPill tone={phase.tone} dot pulse={phase.pulse} data-testid="recorder-state">
            {phase.label}
          </StatusPill>
          <span className="text-[22px] font-semibold tabular-nums" aria-label="Elapsed time" data-testid="recorder-elapsed">
            {formatTime(state.elapsed_s, true)}
          </span>
        </div>
        <Meter peakDbfs={state.level?.peak_dbfs ?? null} rmsDbfs={state.level?.rms_dbfs ?? null} clipped={state.level?.clipped ?? false} resetKey={state.sessionId} />
        <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Transport">
          {state.phase === "idle" || (state.phase === "error" && !state.sessionId) ? (
            <Button variant="primary" size="lg" icon={<Circle className="fill-current" />} onClick={() => void recorder.start()} disabled={devices != null && inputs.length === 0 && !devicesError}>
              Record
            </Button>
          ) : (
            <Button variant="primary" size="lg" icon={<Circle className="fill-current" />} disabled loading={state.phase === "starting"}>
              Record
            </Button>
          )}
          {state.phase === "recording" ? (
            <Button size="lg" icon={<Pause />} onClick={() => void recorder.pause()}>
              Pause
            </Button>
          ) : (
            <Button size="lg" icon={<Play />} onClick={() => void recorder.resume()} disabled={state.phase !== "paused"}>
              Resume
            </Button>
          )}
          <Button size="lg" icon={<Square />} loading={state.phase === "stopping"} onClick={() => void recorder.stop()} disabled={!(state.phase === "recording" || state.phase === "paused" || (state.phase === "error" && !!state.sessionId))}>
            Stop
          </Button>
          <Button size="lg" variant="ghost" icon={<Trash2 />} onClick={() => void recorder.discard()} disabled={!state.sessionId}>
            Discard
          </Button>
        </div>
        {state.clippedInSession && (
          <p className="text-[12.5px] text-danger flex items-center gap-1.5">
            <AlertTriangle className="size-4" /> Clipping was detected in this take — lower the input gain and record again for a clean reference.
          </p>
        )}
        {neg && (
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-[12.5px]" aria-label="Negotiated recording settings">
            <Item label="Backend">{neg.backend ?? neg.hostapi}</Item>
            <Item label="Device">{neg.device_name}</Item>
            <Item label="Sample rate">{neg.sample_rate} Hz · {neg.channels === 1 ? "mono" : `${neg.channels} ch`}</Item>
            <Item label="File">{neg.subtype === "PCM_24" ? "24-bit file — device precision not reported" : `${neg.subtype} · ${neg.dtype}`}</Item>
            {Number.isFinite(neg.latency_s) && <Item label="Latency">{(neg.latency_s * 1000).toFixed(0)} ms</Item>}
            <Item label="Monitoring">{state.monitoring ? "on" : "off"}</Item>
          </dl>
        )}
        {state.notes.length > 0 && (
          <ul className="text-[12px] text-muted list-disc pl-5">
            {state.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        {err && (
          <div role="alert" className="rounded-[var(--radius-control)] border border-danger/40 bg-danger-soft px-4 py-3 text-sm flex flex-col gap-2">
            <p className="font-medium text-danger">
              {err.code === "DEVICE_UNAVAILABLE" ? "Audio device unavailable" : err.code === "DISK_FULL" ? "Disk full" : err.code === "EMPTY_AUDIO" ? "Nothing was recorded" : `Recording failed (${err.code})`}
            </p>
            <p className="text-[13px] text-text">{err.message}</p>
            <div className="flex gap-2 flex-wrap">
              {err.during === "start" || err.during === "discard" || err.code === "EMPTY_AUDIO" ? (
                <Button size="sm" variant="primary" icon={<RefreshCw />} onClick={() => { recorder.clearError(); void loadDevices().then(() => recorder.start()); }}>
                  Retry
                </Button>
              ) : (
                <>
                  <Button size="sm" variant="primary" icon={<Square />} onClick={() => void recorder.stop()}>
                    {err.code === "DISK_FULL" ? "Keep what was captured" : "Stop and keep the take"}
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => void recorder.discard()}>
                    Discard
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" onClick={recorder.clearError}>
                Dismiss
              </Button>
            </div>
          </div>
        )}
      </div>

      {state.takes.length > 0 && (
        <section aria-label="Takes" className="flex flex-col gap-2">
          <h3 className="text-[13px] font-medium text-muted uppercase tracking-wide">Takes ({state.takes.length})</h3>
          <ul className="flex flex-col gap-2">
            {state.takes.map((t) => {
              const isActive = t.asset_id === activeAssetId;
              const isPreview = previewTake?.asset_id === t.asset_id;
              return (
                <li key={t.asset_id} className={cx("rounded-[var(--radius-control)] border px-3 py-2 flex flex-col gap-2", isActive ? "border-accent bg-accent-soft/40" : "border-border")}>
                  <div className="flex items-center gap-3 flex-wrap">
                    <Mic className="size-4 text-muted shrink-0" />
                    <span className="text-sm font-medium">Take {t.take_number}</span>
                    <span className="text-[12.5px] text-muted tabular-nums">
                      {formatDuration(t.duration_s)} · {t.negotiated.sample_rate} Hz
                      {t.stats ? ` · peak ${formatDbfs(t.stats.peak_dbfs)}` : ""}
                      {t.stats && t.stats.clipping_samples > 0 ? ` · ${t.stats.clipping_samples} clipped samples` : ""}
                    </span>
                    <span className="flex-1" />
                    <IconButton size="sm" label={isPreview && player.playing ? "Pause take" : "Play take"} onClick={() => { if (isPreview) void player.toggle(); else setPreviewTake(t); }}>
                      {isPreview && player.playing ? <Pause /> : <Play />}
                    </IconButton>
                    <Button size="sm" variant={isActive ? "secondary" : "primary"} icon={isActive ? <Check /> : undefined} onClick={() => onUseTake(t)}>
                      {isActive ? "Selected" : "Use this take"}
                    </Button>
                    <IconButton size="sm" label={`Discard take ${t.take_number}`} onClick={() => { if (isPreview) setPreviewTake(null); recorder.removeTake(t.asset_id); }}>
                      <Trash2 />
                    </IconButton>
                  </div>
                  {t.stats?.warnings?.length ? (
                    <ul className="text-[12px] text-warn pl-7">
                      {t.stats.warnings.map((w) => (
                        <li key={w.code}>{w.message} (heuristic)</li>
                      ))}
                    </ul>
                  ) : null}
                  {isPreview && <PlayerBar player={player} compact className="pl-7" />}
                </li>
              );
            })}
          </ul>
          <p className="text-[12px] text-muted">Discarding a take here only removes it from this list; the recording stays in your library folder.</p>
        </section>
      )}
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate" title={typeof children === "string" ? children : undefined}>
        {children}
      </dd>
    </div>
  );
}
