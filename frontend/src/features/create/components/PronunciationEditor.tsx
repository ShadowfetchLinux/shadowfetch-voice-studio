import { Plus, Trash2 } from "lucide-react";
import type { PronunciationRule } from "@/lib/protocol";
import { Button, IconButton } from "@/components/ui/Button";

export interface PronunciationEditorProps {
  rules: readonly PronunciationRule[];
  onChange: (rules: PronunciationRule[]) => void;
  disabled?: boolean;
}

/** from → to substitution rows applied by `tts.plan` (whole-word, case-sensitive, reported per segment). */
export function PronunciationEditor({ rules, onChange, disabled }: PronunciationEditorProps) {
  const update = (i: number, patch: Partial<PronunciationRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(rules.filter((_, j) => j !== i));
  return (
    <div className="flex flex-col gap-2">
      <div>
        <h3 className="text-[13px] font-medium">Pronunciation substitutions</h3>
        <p className="text-[12.5px] text-muted mt-0.5">Whole-word, case-sensitive replacements applied when planning. Every match is listed on the segment.</p>
      </div>
      {rules.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Pronunciation rules">
          {rules.map((r, i) => (
            <li key={i} className="flex items-center gap-2">
              <input
                aria-label={`Rule ${i + 1}: from`}
                className="field-input control text-[13px] min-w-0 flex-1"
                placeholder="from"
                value={r.from}
                disabled={disabled}
                onChange={(e) => update(i, { from: e.target.value })}
              />
              <span className="text-muted shrink-0" aria-hidden>
                →
              </span>
              <input
                aria-label={`Rule ${i + 1}: to`}
                className="field-input control text-[13px] min-w-0 flex-1"
                placeholder="to"
                value={r.to}
                disabled={disabled}
                onChange={(e) => update(i, { to: e.target.value })}
              />
              <IconButton size="sm" label={`Remove rule ${i + 1}`} onClick={() => remove(i)} disabled={disabled}>
                <Trash2 />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <Button size="sm" icon={<Plus />} onClick={() => onChange([...rules, { from: "", to: "" }])} disabled={disabled} className="self-start">
        Add rule
      </Button>
    </div>
  );
}
