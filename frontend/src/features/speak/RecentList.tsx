import { useState } from "react";
import { Play, Volume2, X } from "lucide-react";
import type { SpeechEntry } from "@/lib/protocol";
import { cx, formatDuration } from "@/lib/format";

export interface RecentListProps {
  entries: SpeechEntry[];
  currentId: string | null;
  onPlay: (e: SpeechEntry) => void;
  onRemove: (e: SpeechEntry) => void;
  onShowAll: () => void;
}

const COLLAPSED = 3;

/** Compact "Recent": ▶ excerpt · voice · length. Click to play. */
export function RecentList({ entries, currentId, onPlay, onRemove, onShowAll }: RecentListProps) {
  const [expanded, setExpanded] = useState(false);
  // Nothing to show until there is something besides what the player already shows.
  if (!entries.some((e) => e.id !== currentId)) return null;
  const shown = expanded ? entries : entries.slice(0, COLLAPSED);
  return (
    <section aria-labelledby="recent-heading" className="flex flex-col gap-1.5">
      <h2 id="recent-heading" className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">
        Recent
      </h2>
      <ul className="flex flex-col">
        {shown.map((e) => {
          const active = e.id === currentId;
          return (
            <li key={e.id} className="group flex items-center gap-1 -mx-2">
              <button
                type="button"
                onClick={() => onPlay(e)}
                disabled={!e.exists}
                className={cx(
                  "flex-1 min-w-0 flex items-center gap-3 h-9 px-2 rounded-[6px] text-left text-[14px] transition-colors",
                  "hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed",
                  active && "text-accent",
                )}
                aria-label={`Play: ${e.text.slice(0, 80)}`}
              >
                {active ? <Volume2 className="size-3.5 shrink-0" /> : <Play className="size-3.5 shrink-0 text-muted group-hover:text-accent" />}
                <span className="truncate flex-1">{e.text.trim().replace(/\s+/g, " ")}</span>
                <span className="text-[12.5px] text-muted tabular-nums shrink-0">
                  {e.voice_name ? `${e.voice_name} · ` : ""}
                  {formatDuration(e.duration_s)}
                </span>
              </button>
              <button
                type="button"
                aria-label="Remove from Recent"
                title="Remove from Recent"
                onClick={() => onRemove(e)}
                className="size-8 shrink-0 inline-flex items-center justify-center rounded-[6px] text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-hover hover:text-text"
              >
                <X className="size-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
      {entries.length > COLLAPSED && (
        <button
          type="button"
          className="self-start text-[13px] font-medium text-accent hover:underline"
          onClick={() => {
            if (!expanded) onShowAll();
            setExpanded((x) => !x);
          }}
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
    </section>
  );
}
