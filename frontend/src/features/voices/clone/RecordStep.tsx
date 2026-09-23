import { useEffect, useMemo, useRef, useState } from "react";
import { Mic, RotateCcw, Square } from "lucide-react";
import { api } from "@/lib/api";
import type { Device, RecordLevel, RecordScript } from "@/lib/protocol";
import { cx, formatTime } from "@/lib/format";
import { friendlyError } from "@/lib/friendlyErrors";
import { Button } from "@/components/ui/Button";
import { useAppStore } from "@/store/appStore";
import { useRecorder } from "../useRecorder";
import type { RecorderTake } from "../recorderMachine";

const BARS = 56;
const MIN_DB = -60;

/** Scrolling bars of the live input level (RMS from `record.level`); red when a frame clipped. */
export function LiveLevel({ level, active }: { level: RecordLevel | null; active: boolean }) {
  const [bars, setBars] = useState<Array<{ v: number; clip: boolean }>>(() => Array.from({ length: BARS }, () => ({ v: 0, clip: false })));
  const last = useRef<RecordLevel | null>(null);
  useEffect(() => {
    if (!active) {
      setBars(Array.from({ length: BARS }, () => ({ v: 0, clip: false })));
      return;
    }
    if (!level || level === last.current) return;
    last.current = level;
    const db = Math.max(MIN_DB, Math.min(0, level.rms_dbfs));
    const v = (db - MIN_DB) / -MIN_DB;
    setBars((b) => [...b.slice(1), { v, clip: level.clipped }]);
  }, [level, active]);
  return (
    <div className="flex items-center gap-[3px] h-16 w-full" aria-hidden>
      {bars.map((b, i) => (
        <span
          key={i}
          className={cx("flex-1 rounded-full transition-[height] duration-100", b.clip ? "bg-danger" : active ? "bg-accent" : "bg-track")}
          style={{ height: `${Math.max(6, Math.round(b.v * 100))}%`, opacity: active ? 0.35 + 0.65 * (i / BARS) : 1 }}
        />
      ))}
    </div>
  );
}

type DevicesResult = { inputs: Device[]; default_input: number | null };

export interface RecordStepProps {
  /** A finished recording (registered by the worker as a reference asset). */
  onRecorded: (take: RecorderTake) => void;
  /** True while the microphone is open (the dialog asks before closing). */
  onActiveChange: (active: boolean) => void;
}

/** "Record Your Voice": microphone, something to read, one big button, a timer and a live level. */
export function RecordStep({ onRecorded, onActiveChange }: RecordStepProps) {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const [devices, setDevices] = useState<DevicesResult | null>(null);
  const [deviceIndex, setDeviceIndex] = useState<number | null>(settings?.record_device_index ?? null);
  const [scripts, setScripts] = useState<RecordScript[]>([]);
  const [scriptIdx, setScriptIdx] = useState(0);
  const script = scripts[scriptIdx] ?? null;
  const recorder = useRecorder({ deviceIndex, scriptId: script?.id ?? null, sessionName: "Voice sample" });
  const { state } = recorder;
  const recording = state.phase === "recording" || state.phase === "paused";
  const busy = state.phase === "starting" || state.phase === "stopping";
  const active = recording || busy || (state.phase === "error" && !!state.sessionId);
  const handled = useRef(0);

  useEffect(() => onActiveChange(active), [active, onActiveChange]);

  useEffect(() => {
    api.record
      .devices()
      .then((r) => {
        const d = r as DevicesResult;
        setDevices(d);
        setDeviceIndex((cur) => (cur != null && d.inputs.some((x) => x.index === cur) ? cur : null));
      })
      .catch(() => setDevices({ inputs: [], default_input: null }));
    api.record
      .scripts()
      .then((r) => setScripts(r.scripts))
      .catch(() => setScripts([]));
  }, []);

  // A finished take moves the flow on automatically.
  useEffect(() => {
    const take = state.takes[state.takes.length - 1];
    if (take && state.takes.length > handled.current) {
      handled.current = state.takes.length;
      onRecorded(take);
    }
  }, [state.takes, onRecorded]);

  // Plain-language hints from the live level (measured, never guessed).
  const [quietFor, setQuietFor] = useState(0);
  useEffect(() => {
    if (state.phase !== "recording" || !state.level) {
      setQuietFor(0);
      return;
    }
    setQuietFor((q) => (state.level!.peak_dbfs < -40 ? q + 1 : 0));
  }, [state.level, state.phase]);
  const hint = state.clippedInSession ? "That was too loud — move back a little from the microphone." : quietFor > 25 ? "I can barely hear you — move closer to the microphone." : null;

  const inputs = devices?.inputs ?? [];
  const defaultName = useMemo(() => inputs.find((d) => d.index === devices?.default_input)?.name, [inputs, devices]);
  const err = state.error ? friendlyError({ code: state.error.code, message: state.error.message }, "record") : null;

  return (
    <div className="flex flex-col gap-5">
      {script && (
        <div className="rounded-[var(--radius-panel)] bg-panel-alt border border-border px-5 py-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <span className="eyebrow">Read this aloud</span>
            {scripts.length > 1 && (
              <button type="button" className="text-[13px] font-medium text-accent hover:underline disabled:opacity-50" disabled={active} onClick={() => setScriptIdx((i) => (i + 1) % scripts.length)}>
                Something else to read
              </button>
            )}
          </div>
          <p className="text-[16px] leading-relaxed max-h-[168px] overflow-y-auto pr-1">{script.text}</p>
        </div>
      )}

      <div className="flex flex-col items-center gap-3">
        <LiveLevel level={state.level} active={recording} />
        <div className="flex items-center gap-4">
          <span className="text-[28px] font-semibold tabular-nums w-[88px] text-right" aria-label="Recording time" data-testid="recorder-elapsed">
            {formatTime(state.elapsed_s)}
          </span>
          {recording || state.phase === "stopping" ? (
            <button
              type="button"
              onClick={() => void recorder.stop()}
              disabled={state.phase === "stopping"}
              aria-label="Stop recording"
              className="inline-flex items-center justify-center size-[72px] rounded-full bg-danger text-white shadow-md hover:bg-danger-hover disabled:opacity-60"
            >
              <Square className="size-7 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void recorder.start()}
              disabled={busy}
              aria-label="Start recording"
              className="inline-flex items-center justify-center size-[72px] rounded-full bg-danger text-white shadow-md hover:bg-danger-hover disabled:opacity-60"
            >
              <Mic className="size-8" />
            </button>
          )}
          <span className="w-[88px] text-[13px] text-muted">{recording ? (state.elapsed_s < 20 ? "Keep going…" : "Stop when ready") : state.phase === "stopping" ? "Finishing…" : state.phase === "starting" ? "Starting…" : "Press to record"}</span>
        </div>
        <p className={cx("text-[13px] min-h-[20px]", hint ? "text-warn" : "text-muted")} aria-live="polite">
          {hint ?? (recording ? "Speak naturally for about 20–30 seconds." : "")}
        </p>
      </div>

      {err && (
        <div role="alert" className="rounded-[var(--radius-control)] border border-danger/30 bg-danger-soft px-4 py-3 text-[14px] flex items-start gap-3">
          <p className="flex-1">{err.message}</p>
          {state.sessionId ? (
            <Button size="sm" icon={<RotateCcw />} onClick={() => void recorder.discard()}>
              Start over
            </Button>
          ) : (
            <Button size="sm" onClick={() => recorder.clearError()}>
              OK
            </Button>
          )}
        </div>
      )}

      <label className="flex items-center gap-3 text-[13px] text-muted">
        <Mic className="size-4 shrink-0" />
        <span className="shrink-0">Microphone</span>
        <select
          className="field-input control flex-1 min-w-0 text-[13px]"
          value={deviceIndex == null ? "" : String(deviceIndex)}
          disabled={active}
          onChange={(e) => {
            const v = e.target.value === "" ? null : Number(e.target.value);
            setDeviceIndex(v);
            void saveSettings({ record_device_index: v }, { silent: true });
          }}
        >
          <option value="">{devices == null ? "Looking for microphones…" : inputs.length ? `Default${defaultName ? ` — ${defaultName}` : ""}` : "No microphone found"}</option>
          {inputs.map((d) => (
            <option key={d.index} value={String(d.index)}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
