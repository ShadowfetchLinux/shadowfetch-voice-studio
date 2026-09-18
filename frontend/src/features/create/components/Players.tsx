import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { PeakPair } from "@/lib/protocol";
import { api } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { PlayerBar } from "@/components/audio/PlayerBar";
import { usePlayer } from "@/components/audio/usePlayer";
import { Waveform } from "@/components/audio/Waveform";
import { useCreateStore } from "../createStore";
import { registerMasterToggle } from "../editorRef";
import { takeLabel } from "../planMath";

// ---------------------------------------------------------------------------
// Master
// ---------------------------------------------------------------------------

/** Waveform + transport for `master.wav`; registers its play/pause toggle for the Space shortcut. */
export function MasterPlayer() {
  const masterPath = useCreateStore((s) => s.masterPath);
  const master = useCreateStore((s) => s.master);
  const [peaks, setPeaks] = useState<{ path: string; peaks: PeakPair[]; duration: number } | null>(null);
  const [peaksError, setPeaksError] = useState<string | null>(null);
  const player = usePlayer({ path: masterPath });

  useEffect(() => {
    registerMasterToggle(() => void player.toggle());
    return () => registerMasterToggle(null);
  }, [player.toggle]);

  useEffect(() => {
    if (!masterPath) {
      setPeaks(null);
      return;
    }
    let alive = true;
    setPeaksError(null);
    api.audio
      .peaks({ path: masterPath, points: 2000 })
      .then((r) => alive && setPeaks({ path: masterPath, peaks: r.peaks, duration: r.duration_s }))
      .catch((err: unknown) => alive && setPeaksError(err instanceof Error ? err.message : "Could not read the master waveform"));
    return () => {
      alive = false;
    };
  }, [masterPath, master?.duration_s]);

  if (!masterPath) return null;
  const duration = peaks?.duration ?? master?.duration_s ?? player.duration;
  return (
    <Card
      title="Master"
      description={`${master?.segments_used ?? "?"} segments · ${formatDuration(duration)}${master?.sample_rate ? ` · ${master.sample_rate} Hz` : ""} · ${masterPath}`}
    >
      <div className="flex flex-col gap-2">
        {peaks && peaks.path === masterPath ? (
          <Waveform peaks={peaks.peaks} duration={peaks.duration} currentTime={player.currentTime} onSeek={player.seek} height={120} label="Master waveform" />
        ) : peaksError ? (
          <p className="text-[12.5px] text-warn">{peaksError}</p>
        ) : (
          <p className="text-[12.5px] text-muted">Reading waveform…</p>
        )}
        <PlayerBar player={player} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Take preview (one shared audio element for every segment "play" button)
// ---------------------------------------------------------------------------

export function TakePreviewPlayer() {
  const preview = useCreateStore((s) => s.previewTake);
  const stop = useCreateStore((s) => s.stopTakePreview);
  const player = usePlayer({ path: preview?.path ?? null });
  const { ready, play, seek } = player;
  useEffect(() => {
    // re-trigger on every click (nonce) even for the same path
    if (!preview || !ready) return;
    seek(0);
    void play();
  }, [preview, ready, play, seek]);
  if (!preview) return null;
  return (
    <div className="panel px-4 py-2 flex items-center gap-3" aria-label="Take preview">
      <span className="text-[12.5px] text-muted truncate min-w-0">Playing: {preview.label}</span>
      <PlayerBar player={player} compact className="flex-1" />
      <IconButton size="sm" label="Close take preview" onClick={stop}>
        <X />
      </IconButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Take comparison drawer (A/B)
// ---------------------------------------------------------------------------

function TakeSlot({ title, path, children }: { title: string; path: string | null; children: ReactNode }) {
  const player = usePlayer({ path });
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <span className="text-[13px] font-semibold">{title}</span>
      {children}
      <PlayerBar player={player} compact />
    </div>
  );
}

/** Two takes of one segment side by side; "Use this take" calls `projects.select_take`. */
export function TakeDrawer() {
  const index = useCreateStore((s) => s.drawerSegment);
  const segment = useCreateStore((s) => (s.drawerSegment == null ? null : (s.segments.find((x) => x.index === s.drawerSegment) ?? null)));
  const close = useCreateStore((s) => s.openDrawer);
  const selectTake = useCreateStore((s) => s.selectTake);
  const [a, setA] = useState<string | null>(null);
  const [b, setB] = useState<string | null>(null);

  useEffect(() => {
    if (!segment) return;
    const ids = segment.takes.map((t) => t.id);
    setA((cur) => (cur && ids.includes(cur) ? cur : (segment.selected_take_id ?? ids[0] ?? null)));
    setB((cur) => (cur && ids.includes(cur) ? cur : (ids.find((id) => id !== (segment.selected_take_id ?? ids[0])) ?? ids[ids.length - 1] ?? null)));
  }, [segment]);

  if (index == null || !segment) return null;
  const options = segment.takes.map((t, i) => ({ value: t.id, label: takeLabel(t, i) + (t.id === segment.selected_take_id ? " · selected" : "") }));
  const pathOf = (id: string | null) => segment.takes.find((t) => t.id === id)?.path ?? null;
  return (
    <Card
      title={`Compare takes · segment ${index + 1}`}
      description={segment.text.length > 120 ? `${segment.text.slice(0, 120)}…` : segment.text}
      actions={
        <IconButton size="sm" label="Close take comparison" onClick={() => close(null)}>
          <X />
        </IconButton>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <TakeSlot title="A" path={pathOf(a)}>
          <Select aria-label="Take A" options={options} value={a ?? ""} onChange={(e) => setA(e.target.value)} />
          <Button size="sm" variant={a === segment.selected_take_id ? "secondary" : "primary"} disabled={!a || a === segment.selected_take_id} onClick={() => a && void selectTake(index, a)}>
            {a === segment.selected_take_id ? "Selected" : "Use take A"}
          </Button>
        </TakeSlot>
        <TakeSlot title="B" path={pathOf(b)}>
          <Select aria-label="Take B" options={options} value={b ?? ""} onChange={(e) => setB(e.target.value)} />
          <Button size="sm" variant={b === segment.selected_take_id ? "secondary" : "primary"} disabled={!b || b === segment.selected_take_id} onClick={() => b && void selectTake(index, b)}>
            {b === segment.selected_take_id ? "Selected" : "Use take B"}
          </Button>
        </TakeSlot>
      </div>
    </Card>
  );
}
