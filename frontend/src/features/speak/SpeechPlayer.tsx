import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, Pause, Play } from "lucide-react";
import type { ExportFormat, SpeechEntry } from "@/lib/protocol";
import { cx, formatTime } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { usePlayer } from "@/components/audio";
import { FORMATS, saveSpeech } from "./saveAudio";

export interface SpeechPlayerProps {
  entry: SpeechEntry;
  /** True while the store asks for this entry to start playing (auto-play after Speak, a click in Recent). */
  playRequested: boolean;
  /** Called once the requested playback was started. */
  onPlayStarted: () => void;
}

/**
 * "Generated speech": play/pause, scrubber, time, and Save Audio (default format, or pick one from the menu).
 * Mount it with `key={entry.id}` so each result gets a fresh player that is only "ready" once its own file loaded.
 */
export function SpeechPlayer({ entry, playRequested, onPlayStarted }: SpeechPlayerProps) {
  const player = usePlayer({ path: entry.exists ? entry.path : null });
  const { ready, seek, play } = player;
  const [saving, setSaving] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!playRequested) return;
    if (!entry.exists) {
      onPlayStarted();
      return;
    }
    if (!ready) return;
    onPlayStarted();
    seek(0);
    void play({ silent: true });
  }, [playRequested, ready, entry.exists, seek, play, onPlayStarted]);

  useEffect(() => {
    if (!menu) return;
    const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMenu(false);
        toggleRef.current?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const list = items();
        const i = list.indexOf(document.activeElement as HTMLElement);
        list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
      } else if (e.key === "Tab") setMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const save = async (format?: ExportFormat) => {
    setMenu(false);
    setSaving(true);
    try {
      await saveSpeech(entry, format);
    } finally {
      setSaving(false);
    }
  };

  const duration = player.duration || entry.duration_s || 0;
  const missing = !entry.exists;

  return (
    <section aria-label="Generated speech" className="flex flex-col gap-2">
      <div className="flex items-center gap-3 sm:gap-4 flex-wrap sm:flex-nowrap">
        <button
          type="button"
          aria-label={player.playing ? "Pause" : "Play"}
          onClick={() => void player.toggle()}
          disabled={missing || (!player.ready && !player.playing)}
          className="inline-flex items-center justify-center size-12 shrink-0 rounded-full bg-accent text-accent-text shadow-sm hover:bg-accent-hover transition-colors disabled:opacity-50 [&>svg]:size-5"
        >
          {player.playing ? <Pause /> : <Play className="translate-x-[1px]" />}
        </button>
        <span className="text-[13px] tabular-nums text-muted w-10 text-right shrink-0">{formatTime(player.currentTime)}</span>
        <input
          type="range"
          aria-label="Position"
          min={0}
          max={Math.max(0.01, duration)}
          step={0.01}
          value={Math.min(player.currentTime, duration || 0)}
          onChange={(e) => player.seek(parseFloat(e.target.value))}
          disabled={!player.ready}
          className="sfvs-scrubber flex-1 min-w-[120px]"
          style={{ ["--pct" as string]: `${duration ? (Math.min(player.currentTime, duration) / duration) * 100 : 0}%` }}
        />
        <span className="text-[13px] tabular-nums text-muted w-10 shrink-0">{formatTime(duration)}</span>
        <div ref={menuRef} className="relative flex shrink-0">
          <Button variant="primary" icon={<Download />} loading={saving} disabled={missing} onClick={() => void save()} className="rounded-r-none">
            Save Audio
          </Button>
          <button
            ref={toggleRef}
            type="button"
            aria-label="Save as another format"
            aria-haspopup="menu"
            aria-expanded={menu}
            disabled={missing || saving}
            onClick={() => setMenu((m) => !m)}
            className="inline-flex items-center justify-center w-9 h-10 rounded-r-[var(--radius-control)] bg-accent text-accent-text border-l border-white/25 hover:bg-accent-hover disabled:opacity-55"
          >
            <ChevronDown className="size-4" />
          </button>
          {menu && (
            <div role="menu" aria-label="Save format" className="absolute right-0 bottom-[calc(100%+6px)] z-40 w-[230px] panel shadow-[var(--shadow-pop)] py-1.5">
              {FORMATS.map((f) => (
                <button key={f.id} type="button" role="menuitem" onClick={() => void save(f.id)} className="flex w-full items-baseline justify-between gap-3 px-3.5 py-2 text-left text-[14px] hover:bg-accent-soft">
                  <span className="font-medium">Save as {f.label}</span>
                  <span className="text-[12px] text-muted">{f.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <p className={cx("text-[13px] truncate pl-[60px]", missing ? "text-danger" : "text-muted")} title={entry.text}>
        {missing ? "This audio file is no longer on disk." : player.error ? "This audio couldn't be played." : `${entry.voice_name ? `${entry.voice_name} · ` : ""}“${entry.text.trim().replace(/\s+/g, " ")}”`}
      </p>
    </section>
  );
}
