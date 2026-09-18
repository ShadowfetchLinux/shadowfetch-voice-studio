import { Pause, Play, Repeat, Scissors, Volume1, Volume2, VolumeX } from "lucide-react";
import { cx, formatTime } from "@/lib/format";
import { IconButton } from "@/components/ui/Button";
import type { Player } from "./usePlayer";

export interface PlayerBarProps {
  player: Player;
  /** Show the "loop selection" / "play selection only" toggles (needs a selection to be meaningful). */
  hasSelection?: boolean;
  compact?: boolean;
  className?: string;
}

/** Transport bar: play/pause, time, scrub, volume, plus selection-only and loop toggles. */
export function PlayerBar({ player, hasSelection = false, compact = false, className }: PlayerBarProps) {
  const { playing, currentTime, duration, volume, ready } = player;
  const VolIcon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  return (
    <div className={cx("flex items-center gap-3 min-w-0", compact ? "h-10" : "h-12 px-2", className)} role="group" aria-label="Playback">
      <IconButton
        label={playing ? "Pause" : "Play"}
        variant="primary"
        size={compact ? "sm" : "md"}
        onClick={() => void player.toggle()}
        disabled={!ready && !playing}
      >
        {playing ? <Pause /> : <Play />}
      </IconButton>
      <span className="text-[12.5px] tabular-nums text-muted w-[54px] text-right shrink-0">{formatTime(currentTime, true)}</span>
      <input
        type="range"
        aria-label="Position"
        min={0}
        max={Math.max(0.01, duration)}
        step={0.01}
        value={Math.min(currentTime, duration || 0)}
        onChange={(e) => player.seek(parseFloat(e.target.value))}
        disabled={!ready}
        className="flex-1 min-w-[80px] h-10 accent-accent cursor-pointer disabled:cursor-not-allowed"
      />
      <span className="text-[12.5px] tabular-nums text-muted w-[54px] shrink-0">{formatTime(duration, true)}</span>
      {hasSelection && (
        <>
          <IconButton
            label={player.restrictToSelection ? "Play whole file" : "Play selection only"}
            size="sm"
            variant={player.restrictToSelection ? "secondary" : "ghost"}
            aria-pressed={player.restrictToSelection}
            onClick={() => player.setRestrictToSelection(!player.restrictToSelection)}
          >
            <Scissors />
          </IconButton>
          <IconButton
            label={player.loop ? "Stop looping" : "Loop selection"}
            size="sm"
            variant={player.loop ? "secondary" : "ghost"}
            aria-pressed={player.loop}
            onClick={() => {
              const next = !player.loop;
              player.setLoop(next);
              if (next) player.setRestrictToSelection(true);
            }}
          >
            <Repeat />
          </IconButton>
        </>
      )}
      <div className="flex items-center gap-1 shrink-0">
        <IconButton label={volume === 0 ? "Unmute" : "Mute"} size="sm" onClick={() => player.setVolume(volume === 0 ? 1 : 0)}>
          <VolIcon />
        </IconButton>
        <input
          type="range"
          aria-label="Volume"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => player.setVolume(parseFloat(e.target.value))}
          className="w-20 h-10 accent-accent cursor-pointer"
        />
      </div>
      {player.error && (
        <span role="alert" className="text-[12px] text-danger truncate max-w-[200px]" title={player.error}>
          {player.error}
        </span>
      )}
    </div>
  );
}
