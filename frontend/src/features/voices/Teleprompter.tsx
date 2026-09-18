import { BookOpenText } from "lucide-react";
import type { RecordScript } from "@/lib/protocol";
import { cx } from "@/lib/format";
import { StatusPill } from "@/components/ui/Feedback";

export interface TeleprompterProps {
  scripts: RecordScript[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Loading / error text for the script list. */
  status?: string | null;
  disabled?: boolean;
}

const STYLE_LABEL: Record<string, string> = { conversational: "Conversational", calm_narration: "Calm narration", energetic_presentation: "Energetic presentation" };

/** Guided script picker + large readable card. Scripts come from `record.scripts`; nothing is invented here. */
export function Teleprompter({ scripts, selectedId, onSelect, status, disabled }: TeleprompterProps) {
  const selected = scripts.find((s) => s.id === selectedId) ?? null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm font-medium">
          <BookOpenText className="size-4 text-muted" /> Guided script
        </div>
        <span className="text-[12.5px] text-muted">Aim for 30–60 s of natural speech; you will trim a 10–15 s reference from it.</span>
      </div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Reading script">
        <button
          type="button"
          role="radio"
          aria-checked={selectedId === null}
          disabled={disabled}
          onClick={() => onSelect(null)}
          className={cx("h-10 px-3 rounded-[var(--radius-control)] border text-sm font-medium", selectedId === null ? "border-accent bg-accent-soft text-accent" : "border-border-strong bg-panel hover:bg-panel-alt")}
        >
          Free speech
        </button>
        {scripts.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={selectedId === s.id}
            disabled={disabled}
            onClick={() => onSelect(s.id)}
            className={cx("h-10 px-3 rounded-[var(--radius-control)] border text-sm font-medium", selectedId === s.id ? "border-accent bg-accent-soft text-accent" : "border-border-strong bg-panel hover:bg-panel-alt")}
          >
            {STYLE_LABEL[s.style] ?? s.title}
          </button>
        ))}
        {status && <span className="text-[12.5px] text-muted self-center">{status}</span>}
      </div>
      {selected ? (
        <article className="rounded-[var(--radius-panel)] border border-border bg-panel-alt px-6 py-5" aria-label={`Script: ${selected.title}`}>
          <header className="flex items-center justify-between gap-3 mb-3">
            <h3 className="text-[15px]">{selected.title}</h3>
            <StatusPill size="sm">≈ {selected.approx_seconds} s at a typical pace</StatusPill>
          </header>
          <p className="text-[19px] leading-[1.65] text-text max-w-[70ch]">{selected.text}</p>
        </article>
      ) : (
        <p className="text-[13px] text-muted rounded-[var(--radius-panel)] border border-dashed border-border-strong px-5 py-4">
          Speak freely in your normal voice: vary the rhythm a little, include a question and a longer sentence, and avoid background noise.
        </p>
      )}
    </div>
  );
}
