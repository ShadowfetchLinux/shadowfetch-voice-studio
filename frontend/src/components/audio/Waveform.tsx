import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import type { PeakPair } from "@/lib/protocol";
import { clamp, cx, formatTime } from "@/lib/format";
import { IconButton } from "@/components/ui/Button";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampSelection,
  clampZoom,
  columnPeaks,
  contentWidth,
  nudgeSelection,
  tickLabel,
  tickStep,
  timeToContentX,
  timeToX,
  xToTime,
  zoomAround,
  type Selection,
  type View,
} from "./waveformMath";

export type { Selection } from "./waveformMath";

export interface WaveformMarker {
  time: number;
  label?: string;
  color?: string;
}

export interface WaveformProps {
  peaks: readonly PeakPair[];
  /** Duration in seconds (from `audio.peaks` / probe). */
  duration: number;
  /** Playhead position in seconds. */
  currentTime?: number;
  onSeek?: (t: number) => void;
  /** Enables the trim selection with draggable handles. */
  selectable?: boolean;
  selection?: Selection | null;
  onSelectionChange?: (sel: Selection | null) => void;
  minSelection?: number;
  markers?: WaveformMarker[];
  height?: number;
  /** Controlled zoom (1–16). */
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  /** Show the +/−/fit zoom buttons. */
  showZoomControls?: boolean;
  /** Dim (grey) waveform outside the selection. */
  dimOutsideSelection?: boolean;
  className?: string;
  /** Accessible name for the canvas. */
  label?: string;
}

const RULER_H = 20;
const HANDLE_W = 10;

const FALLBACK_COLORS = {
  bg: "#faf9f6",
  ruler: "#f1eee8",
  rulerText: "#656d7a",
  grid: "#e6e2dc",
  wave: "#2f6fe4",
  waveDim: "#b8c4dd",
  selection: "rgba(47,111,228,0.12)",
  selectionEdge: "#2559c4",
  playhead: "#1f2328",
  marker: "#b45309",
};

/** Canvas colours from the theme tokens (light or dark), falling back to the light palette. */
function themeColors(el: Element | null): typeof FALLBACK_COLORS {
  const cs = el && typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
  const v = (name: string, fallback: string) => cs?.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--color-panel-alt", FALLBACK_COLORS.bg),
    ruler: v("--color-wave-ruler", FALLBACK_COLORS.ruler),
    rulerText: v("--color-muted", FALLBACK_COLORS.rulerText),
    grid: v("--color-border", FALLBACK_COLORS.grid),
    wave: v("--color-accent", FALLBACK_COLORS.wave),
    waveDim: v("--color-wave-dim", FALLBACK_COLORS.waveDim),
    selection: v("--color-wave-selection", FALLBACK_COLORS.selection),
    selectionEdge: v("--color-accent-hover", FALLBACK_COLORS.selectionEdge),
    playhead: v("--color-text", FALLBACK_COLORS.playhead),
    marker: v("--color-warn", FALLBACK_COLORS.marker),
  };
}

/**
 * Canvas waveform with playhead, click/drag seek, optional trim selection with draggable +
 * keyboard-nudgeable handles, ctrl+wheel / button zoom (1×–16×) and horizontal scrolling.
 * Rendering only covers the visible window, so zoomed-in views stay cheap.
 */
export function Waveform({
  peaks,
  duration,
  currentTime = 0,
  onSeek,
  selectable = false,
  selection = null,
  onSelectionChange,
  minSelection = 0.05,
  markers,
  height = 160,
  zoom: zoomProp,
  onZoomChange,
  showZoomControls = true,
  dimOutsideSelection = true,
  className,
  label = "Waveform",
}: WaveformProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [scrollX, setScrollX] = useState(0);
  const [zoomState, setZoomState] = useState(1);
  const zoom = clampZoom(zoomProp ?? zoomState);
  const setZoom = useCallback(
    (z: number) => {
      const zz = clampZoom(z);
      setZoomState(zz);
      onZoomChange?.(zz);
    },
    [onZoomChange],
  );

  const view: View = useMemo(() => ({ width, zoom, scrollX, duration }), [width, zoom, scrollX, duration]);
  const cw = contentWidth(view);

  // --- size tracking
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // keep scroll offset in sync with the DOM scroller
  const applyScroll = useCallback((x: number) => {
    const el = scrollerRef.current;
    const v = clamp(x, 0, el ? Math.max(0, el.scrollWidth - el.clientWidth) : x);
    if (el && Math.abs(el.scrollLeft - v) > 0.5) el.scrollLeft = v;
    setScrollX(v);
  }, []);

  // --- zoom with ctrl+wheel (non-passive so we can preventDefault the page zoom)
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchorX = e.clientX - rect.left;
      const factor = e.deltaY < 0 ? 1.25 : 0.8;
      const next = zoomAround({ width: el.clientWidth, zoom, scrollX: el.scrollLeft, duration }, factor, anchorX);
      setZoom(next.zoom);
      requestAnimationFrame(() => applyScroll(next.scrollX));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, duration, setZoom, applyScroll]);

  const zoomBy = (factor: number) => {
    const el = scrollerRef.current;
    const w = el?.clientWidth ?? width;
    // anchor on the playhead when visible, else the centre
    const px = timeToX(currentTime, view);
    const anchorX = px >= 0 && px <= w ? px : w / 2;
    const next = zoomAround({ width: w, zoom, scrollX, duration }, factor, anchorX);
    setZoom(next.zoom);
    requestAnimationFrame(() => applyScroll(next.scrollX));
  };

  // --- drawing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = width;
    const h = height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const COLORS = themeColors(canvas);

    // background + ruler strip
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = COLORS.ruler;
    ctx.fillRect(0, 0, w, RULER_H);

    const waveTop = RULER_H;
    const waveH = h - RULER_H;
    const mid = waveTop + waveH / 2;
    const from = duration > 0 ? scrollX / cw : 0;
    const to = duration > 0 ? (scrollX + w) / cw : 1;

    // grid / ruler ticks
    if (duration > 0) {
      const pxPerSec = cw / duration;
      const step = tickStep(pxPerSec);
      const t0 = Math.floor(from * duration / step) * step;
      ctx.font = "10.5px Inter, 'Segoe UI', system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillStyle = COLORS.rulerText;
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      for (let t = t0; t <= to * duration + step; t += step) {
        const x = Math.round(timeToX(t, view)) + 0.5;
        if (x < -40 || x > w + 40) continue;
        ctx.beginPath();
        ctx.moveTo(x, RULER_H - 5);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.fillText(tickLabel(t, step), x + 3, RULER_H / 2);
      }
    }

    // waveform columns
    const cols = columnPeaks(peaks, Math.max(1, Math.floor(w)), from, to);
    const selStartX = selection ? timeToX(selection.start, view) : null;
    const selEndX = selection ? timeToX(selection.end, view) : null;
    for (let x = 0; x < cols.length; x++) {
      const [mn, mx] = cols[x]!;
      const inSel = selStartX == null || selEndX == null || (x >= selStartX && x <= selEndX);
      ctx.fillStyle = selection && dimOutsideSelection && !inSel ? COLORS.waveDim : COLORS.wave;
      const y1 = mid - clamp(mx, -1, 1) * (waveH / 2 - 2);
      const y2 = mid - clamp(mn, -1, 1) * (waveH / 2 - 2);
      ctx.fillRect(x, Math.min(y1, y2), 1, Math.max(1, Math.abs(y2 - y1)));
    }
    // centre line
    ctx.fillStyle = COLORS.grid;
    ctx.fillRect(0, Math.round(mid), w, 1);

    // selection tint + edges
    if (selection && selStartX != null && selEndX != null) {
      ctx.fillStyle = COLORS.selection;
      ctx.fillRect(selStartX, waveTop, selEndX - selStartX, waveH);
      ctx.fillStyle = COLORS.selectionEdge;
      ctx.fillRect(Math.round(selStartX), waveTop, 1, waveH);
      ctx.fillRect(Math.round(selEndX) - 1, waveTop, 1, waveH);
    }

    // markers
    for (const m of markers ?? []) {
      const x = Math.round(timeToX(m.time, view)) + 0.5;
      if (x < 0 || x > w) continue;
      ctx.strokeStyle = m.color ?? COLORS.marker;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, waveTop);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.setLineDash([]);
      if (m.label) {
        ctx.fillStyle = m.color ?? COLORS.marker;
        ctx.fillText(m.label, x + 3, waveTop + 8);
      }
    }

    // playhead
    const px = Math.round(timeToX(currentTime, view));
    if (px >= 0 && px <= w) {
      ctx.fillStyle = COLORS.playhead;
      ctx.fillRect(px, 0, 2, h);
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 7, 0);
      ctx.lineTo(px + 1, 7);
      ctx.closePath();
      ctx.fill();
    }
  }, [peaks, width, height, scrollX, zoom, duration, currentTime, selection, markers, view, cw, dimOutsideSelection]);

  // --- pointer interaction on the canvas: click = seek, drag = select (when selectable) or scrub
  const drag = useRef<{ startX: number; startT: number; moved: boolean } | null>(null);
  const localX = (e: ReactPointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? e.clientX - rect.left : 0;
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const x = localX(e);
    drag.current = { startX: x, startT: xToTime(x, view), moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!selectable) onSeek?.(xToTime(x, view));
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const x = localX(e);
    if (!d.moved && Math.abs(x - d.startX) < 4) return;
    d.moved = true;
    const t = xToTime(x, view);
    if (selectable) onSelectionChange?.(clampSelection({ start: d.startT, end: t }, duration, minSelection));
    else onSeek?.(t);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d.moved) onSeek?.(d.startT);
  };

  // --- handles
  const handleDrag = useRef<{ which: "start" | "end"; pointerId: number } | null>(null);
  const onHandleDown = (which: "start" | "end") => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    handleDrag.current = { which, pointerId: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const hd = handleDrag.current;
    if (!hd || !selection) return;
    const rect = scrollerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const t = xToTime(e.clientX - rect.left, view);
    const next = hd.which === "start" ? { start: Math.min(t, selection.end - minSelection), end: selection.end } : { start: selection.start, end: Math.max(t, selection.start + minSelection) };
    onSelectionChange?.(clampSelection(next, duration, minSelection));
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (handleDrag.current) e.currentTarget.releasePointerCapture(handleDrag.current.pointerId);
    handleDrag.current = null;
  };
  const onHandleKey = (which: "start" | "end") => (e: KeyboardEvent<HTMLDivElement>) => {
    if (!selection) return;
    let dir: 1 | -1 | 0 = 0;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") dir = -1;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") dir = 1;
    else if (e.key === "Home" && which === "start") {
      e.preventDefault();
      onSelectionChange?.(clampSelection({ start: 0, end: selection.end }, duration, minSelection));
      return;
    } else if (e.key === "End" && which === "end") {
      e.preventDefault();
      onSelectionChange?.(clampSelection({ start: selection.start, end: duration }, duration, minSelection));
      return;
    } else return;
    e.preventDefault();
    onSelectionChange?.(nudgeSelection(selection, which, dir, e.shiftKey, duration, minSelection));
  };

  const handleStyle = (t: number) => ({ left: `${timeToContentX(t, view) - HANDLE_W / 2}px`, top: RULER_H, height: height - RULER_H, width: HANDLE_W });

  return (
    <div className={cx("flex flex-col gap-2 min-w-0", className)}>
      <div
        ref={scrollerRef}
        className="relative w-full overflow-x-auto overflow-y-hidden rounded-[var(--radius-control)] border border-border bg-panel-alt select-none"
        onScroll={(e) => {
          // the scroller sizes to its content, so only horizontal scrolling is meaningful
          if (e.currentTarget.scrollTop !== 0) e.currentTarget.scrollTop = 0;
          setScrollX(e.currentTarget.scrollLeft);
        }}
      >
        {/* scroll spacer: content width at the current zoom */}
        <div style={{ width: cw, height, position: "relative" }}>
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`${label}, ${formatTime(duration, true)} long${selection ? `, selection ${formatTime(selection.start, true)} to ${formatTime(selection.end, true)}` : ""}`}
            style={{ width, height, position: "sticky", left: 0, top: 0, display: "block", cursor: selectable ? "text" : "pointer", touchAction: "none" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {selectable && selection && (
            <>
              <div
                role="slider"
                tabIndex={0}
                aria-label="Selection start"
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={selection.start}
                aria-valuetext={formatTime(selection.start, true)}
                title="Drag or use arrow keys (shift = 0.5 s)"
                onPointerDown={onHandleDown("start")}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
                onKeyDown={onHandleKey("start")}
                className="absolute z-10 cursor-ew-resize group outline-none"
                style={handleStyle(selection.start)}
              >
                <span className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[3px] bg-accent-hover group-focus-visible:bg-text group-hover:w-[4px]" />
                <span className="absolute top-0 left-1/2 -translate-x-1/2 h-4 w-[10px] rounded-b bg-accent-hover group-focus-visible:bg-text" />
              </div>
              <div
                role="slider"
                tabIndex={0}
                aria-label="Selection end"
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={selection.end}
                aria-valuetext={formatTime(selection.end, true)}
                title="Drag or use arrow keys (shift = 0.5 s)"
                onPointerDown={onHandleDown("end")}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
                onKeyDown={onHandleKey("end")}
                className="absolute z-10 cursor-ew-resize group outline-none"
                style={handleStyle(selection.end)}
              >
                <span className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[3px] bg-accent-hover group-focus-visible:bg-text group-hover:w-[4px]" />
                <span className="absolute top-0 left-1/2 -translate-x-1/2 h-4 w-[10px] rounded-b bg-accent-hover group-focus-visible:bg-text" />
              </div>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 text-[12px] text-muted tabular-nums">
        <span>
          {formatTime(currentTime, true)} / {formatTime(duration, true)}
          {selection && (
            <span className="ml-3">
              Selection {formatTime(selection.start, true)} – {formatTime(selection.end, true)} ({(selection.end - selection.start).toFixed(2)} s)
            </span>
          )}
        </span>
        {showZoomControls && (
          <span className="flex items-center gap-1">
            <IconButton size="sm" label="Zoom out (ctrl + wheel)" onClick={() => zoomBy(0.8)} disabled={zoom <= MIN_ZOOM}>
              <ZoomOut />
            </IconButton>
            <span className="w-10 text-center">{zoom.toFixed(zoom < 10 ? 1 : 0)}×</span>
            <IconButton size="sm" label="Zoom in (ctrl + wheel)" onClick={() => zoomBy(1.25)} disabled={zoom >= MAX_ZOOM}>
              <ZoomIn />
            </IconButton>
            <IconButton
              size="sm"
              label="Fit to width"
              onClick={() => {
                setZoom(1);
                requestAnimationFrame(() => applyScroll(0));
              }}
              disabled={zoom === 1}
            >
              <Maximize2 />
            </IconButton>
          </span>
        )}
      </div>
    </div>
  );
}

