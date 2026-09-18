import { memo } from "react";
import { GitCompare, Play, RotateCcw } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { EmptyState, StatusPill, type PillTone } from "@/components/ui/Feedback";
import { cx } from "@/lib/format";
import { useCreateStore } from "../createStore";
import { selectedTake, takeLabel } from "../planMath";
import type { SegmentStatus, SegmentView } from "../types";

const STATUS: Record<SegmentStatus, { text: string; tone: PillTone; pulse?: boolean }> = {
  none: { text: "No take", tone: "neutral" },
  queued: { text: "Queued", tone: "warn" },
  generating: { text: "Generating", tone: "accent", pulse: true },
  ok: { text: "Take ready", tone: "success" },
  failed: { text: "Failed", tone: "danger" },
};

export interface SegmentCardProps {
  segment: SegmentView;
  busy: boolean;
  highlighted: boolean;
  onRegenerate: (index: number) => void;
  onSelectTake: (index: number, takeId: string) => void;
  onPlay: (path: string, label: string) => void;
  onCompare: (index: number) => void;
}

export const SegmentCard = memo(function SegmentCard({ segment: s, busy, highlighted, onRegenerate, onSelectTake, onPlay, onCompare }: SegmentCardProps) {
  const st = STATUS[s.status];
  const take = selectedTake(s);
  const changed = s.normalized_text !== s.text;
  return (
    <article
      aria-label={`Segment ${s.index + 1}`}
      data-segment-index={s.index}
      className={cx("rounded-[var(--radius-control)] border px-4 py-3 flex flex-col gap-2 bg-panel", highlighted ? "border-accent shadow-[0_0_0_3px_var(--color-accent-soft)]" : "border-border")}
    >
      <header className="flex items-center gap-2 flex-wrap text-[12.5px] text-muted">
        <span className="font-semibold text-text tabular-nums">#{s.index + 1}</span>
        <span>Paragraph {s.paragraph + 1}</span>
        <span className="tabular-nums">{s.char_count} chars</span>
        <StatusPill tone={st.tone} dot pulse={st.pulse} size="sm" className="ml-auto">
          {st.text}
        </StatusPill>
      </header>
      <p className="text-[14px] leading-relaxed whitespace-pre-wrap">{s.text}</p>
      {changed && (
        <div className="rounded-md bg-panel-alt border border-border px-3 py-2 text-[13px]">
          <p className="text-muted text-[12px] font-medium uppercase tracking-wide">Engine receives</p>
          <p className="whitespace-pre-wrap mt-0.5">{s.normalized_text}</p>
          {s.substitutions.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Substitutions">
              {s.substitutions.map((sub, i) => (
                <li key={`${sub.from}-${i}`} className="text-[12px] px-2 h-6 inline-flex items-center rounded-full bg-accent-soft text-accent">
                  <code className="text-accent">{sub.from}</code>
                  <span className="mx-1" aria-hidden>
                    →
                  </span>
                  <code className="text-accent">{sub.to}</code>
                  {sub.count > 1 && <span className="ml-1">×{sub.count}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {s.error && (
        <p role="alert" className="text-[12.5px] text-danger">
          {s.error}
        </p>
      )}
      <footer className="flex items-center gap-2 flex-wrap">
        {s.takes.length > 0 ? (
          <Select
            aria-label={`Takes for segment ${s.index + 1}`}
            options={s.takes.map((t, i) => ({ value: t.id, label: takeLabel(t, i) + (t.status === "failed" ? " · failed" : "") }))}
            value={s.selected_take_id ?? ""}
            onChange={(e) => onSelectTake(s.index, e.target.value)}
            selectClassName="h-9 min-h-9 text-[13px] w-[260px]"
            disabled={busy}
          />
        ) : (
          <span className="text-[12.5px] text-muted">No takes yet</span>
        )}
        <IconButton size="sm" label={`Play take of segment ${s.index + 1}`} disabled={!take || take.status !== "ok"} onClick={() => take && onPlay(take.path, `Segment ${s.index + 1} · ${takeLabel(take, s.takes.indexOf(take))}`)}>
          <Play />
        </IconButton>
        {s.takes.length > 1 && (
          <IconButton size="sm" label={`Compare takes of segment ${s.index + 1}`} onClick={() => onCompare(s.index)}>
            <GitCompare />
          </IconButton>
        )}
        <Button size="sm" icon={<RotateCcw />} className="ml-auto" disabled={busy} onClick={() => onRegenerate(s.index)} title="Scope: this whole segment is generated again as a new take">
          Regenerate this segment
        </Button>
        <span className="text-[11.5px] text-muted basis-full">Scope: whole segment — a new take is added; older takes stay selectable.</span>
      </footer>
    </article>
  );
});

export interface SegmentListProps {
  /** Segment indexes overlapping the editor selection (highlighted). */
  selectedIndexes: readonly number[];
}

/** The planned segments in order with their takes, statuses and per-segment actions. */
export function SegmentList({ selectedIndexes }: SegmentListProps) {
  const segments = useCreateStore((s) => s.segments);
  const busy = useCreateStore((s) => s.job != null);
  const generate = useCreateStore((s) => s.generate);
  const selectTake = useCreateStore((s) => s.selectTake);
  const playTake = useCreateStore((s) => s.playTake);
  const openDrawer = useCreateStore((s) => s.openDrawer);
  const warnings = useCreateStore((s) => s.planWarnings);
  const notes = useCreateStore((s) => s.planNotes);
  const hasProject = useCreateStore((s) => s.projectId != null);

  if (!hasProject) return null;
  if (segments.length === 0) {
    return <EmptyState compact title="Not planned yet" text="Press Plan to split the script into engine-sized segments. Nothing is generated until you ask." />;
  }
  const highlighted = new Set(selectedIndexes);
  return (
    <section aria-label="Segments" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[15px]">
          {segments.length} segment{segments.length === 1 ? "" : "s"}
        </h2>
        <span className="text-[12.5px] text-muted">{segments.filter((s) => s.status === "ok").length} with a take</span>
      </div>
      {(warnings.length > 0 || notes.length > 0) && (
        <ul className="text-[12.5px] flex flex-col gap-1" aria-label="Plan notes">
          {warnings.map((w, i) => (
            <li key={`w${i}`} className="text-warn">
              {w}
            </li>
          ))}
          {notes.map((n, i) => (
            <li key={`n${i}`} className="text-muted">
              {n}
            </li>
          ))}
        </ul>
      )}
      {segments.map((seg) => (
        <SegmentCard
          key={seg.id ?? seg.index}
          segment={seg}
          busy={busy}
          highlighted={highlighted.has(seg.index)}
          onRegenerate={(i) => void generate({ mode: "indices", indices: [i] })}
          onSelectTake={(i, takeId) => void selectTake(i, takeId)}
          onPlay={playTake}
          onCompare={openDrawer}
        />
      ))}
    </section>
  );
}
