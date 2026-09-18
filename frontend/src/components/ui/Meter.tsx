import { useEffect, useRef, useState } from "react";
import { clamp, cx, formatDbfs } from "@/lib/format";

export interface MeterProps {
  /** Current peak level in dBFS (null = no signal / not running). */
  peakDbfs: number | null | undefined;
  /** Current RMS level in dBFS. */
  rmsDbfs?: number | null;
  /** True when the source reported clipping for this frame; latches the CLIP indicator. */
  clipped?: boolean;
  /** Lowest value on the scale. */
  minDb?: number;
  /** Peak-hold time in ms. */
  holdMs?: number;
  /** Reset the latched clip indicator when this value changes (e.g. a new session id). */
  resetKey?: unknown;
  label?: string;
  className?: string;
}

const TICKS = [-60, -48, -36, -24, -18, -12, -6, -3, 0];

/**
 * Horizontal level meter with RMS fill, peak marker, peak hold and a latched clip indicator.
 * Values are dBFS straight from `record.level` events — nothing is smoothed into a fake reading.
 */
export function Meter({ peakDbfs, rmsDbfs, clipped, minDb = -60, holdMs = 1500, resetKey, label = "Input level", className }: MeterProps) {
  const [hold, setHold] = useState<number | null>(null);
  const [clipLatched, setClipLatched] = useState(false);
  const holdTimer = useRef<number | null>(null);

  const toPct = (db: number | null | undefined) => (db == null || !Number.isFinite(db) ? 0 : (clamp(db, minDb, 0) - minDb) / -minDb * 100);
  const peakPct = toPct(peakDbfs);
  const rmsPct = toPct(rmsDbfs);

  useEffect(() => {
    if (peakDbfs == null || !Number.isFinite(peakDbfs)) return;
    if (hold == null || peakDbfs >= hold) {
      setHold(peakDbfs);
      if (holdTimer.current) window.clearTimeout(holdTimer.current);
      holdTimer.current = window.setTimeout(() => setHold(null), holdMs);
    }
  }, [peakDbfs, hold, holdMs]);

  useEffect(() => {
    if (clipped) setClipLatched(true);
  }, [clipped]);

  const lastReset = useRef(resetKey);
  useEffect(() => {
    if (Object.is(lastReset.current, resetKey)) return;
    lastReset.current = resetKey;
    setClipLatched(false);
    setHold(null);
  }, [resetKey]);

  useEffect(() => () => {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
  }, []);

  const zoneColor = (pct: number) => (pct > toPct(-3) ? "bg-danger" : pct > toPct(-12) ? "bg-warn" : "bg-success");

  return (
    <div className={cx("flex flex-col gap-1 min-w-0", className)}>
      <div className="flex items-center justify-between text-[12px] text-muted">
        <span>{label}</span>
        <span className="tabular-nums">
          peak {formatDbfs(peakDbfs)}
          {rmsDbfs != null && <span className="ml-2">rms {formatDbfs(rmsDbfs)}</span>}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={minDb}
          aria-valuemax={0}
          aria-valuenow={peakDbfs ?? minDb}
          aria-valuetext={formatDbfs(peakDbfs)}
          className="relative flex-1 h-4 rounded-[4px] bg-sidebar overflow-hidden"
        >
          {/* peak fill (translucent) */}
          <div className={cx("absolute inset-y-0 left-0 opacity-45 transition-[width] duration-75", zoneColor(peakPct))} style={{ width: `${peakPct}%` }} />
          {/* RMS fill on top (solid) */}
          <div className={cx("absolute inset-y-0 left-0 transition-[width] duration-75", zoneColor(rmsPct))} style={{ width: `${rmsPct}%` }} />
          {/* peak hold marker */}
          {hold != null && <div className="absolute inset-y-0 w-[2px] bg-white" style={{ left: `calc(${toPct(hold)}% - 1px)` }} />}
          {/* zone markers */}
          <div className="absolute inset-y-0 w-px bg-white/30" style={{ left: `${toPct(-12)}%` }} />
          <div className="absolute inset-y-0 w-px bg-white/30" style={{ left: `${toPct(-3)}%` }} />
        </div>
        <button
          type="button"
          onClick={() => setClipLatched(false)}
          title={clipLatched ? "Clipping detected — click to reset" : "No clipping"}
          aria-pressed={clipLatched}
          className={cx(
            "h-6 px-1.5 rounded-[4px] text-[10.5px] font-bold tracking-wide border",
            clipLatched ? "bg-danger text-white border-danger" : "bg-panel text-muted border-border-strong",
          )}
        >
          CLIP
        </button>
      </div>
      <div className="relative h-3 text-[10px] text-muted tabular-nums select-none" aria-hidden>
        {TICKS.filter((t) => t >= minDb).map((t) => (
          <span key={t} className="absolute -translate-x-1/2" style={{ left: `${toPct(t)}%` }}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}
