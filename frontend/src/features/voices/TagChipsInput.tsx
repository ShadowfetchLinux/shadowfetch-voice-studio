import { useId, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cx } from "@/lib/format";

export interface TagChipsInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  label?: string;
  hint?: string;
  placeholder?: string;
  /** Known tags offered as quick-add suggestions. */
  suggestions?: string[];
  disabled?: boolean;
  className?: string;
}

/** Normalise a typed tag: trimmed, single spaces, no commas. */
export function normalizeTag(raw: string): string {
  return raw.replace(/,/g, " ").replace(/\s+/g, " ").trim();
}

/** Chip editor: Enter/comma adds, Backspace on an empty field removes the last chip. Shared by voices and library. */
export function TagChipsInput({ value, onChange, label = "Tags", hint, placeholder = "Add a tag and press Enter", suggestions = [], disabled, className }: TagChipsInputProps) {
  const id = useId();
  const [draft, setDraft] = useState("");

  const add = (raw: string) => {
    const tag = normalizeTag(raw);
    if (!tag) return;
    if (!value.some((t) => t.toLowerCase() === tag.toLowerCase())) onChange([...value, tag]);
    setDraft("");
  };
  const remove = (tag: string) => onChange(value.filter((t) => t !== tag));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      e.preventDefault();
      remove(value[value.length - 1]!);
    }
  };

  const unused = suggestions.filter((s) => !value.some((t) => t.toLowerCase() === s.toLowerCase())).slice(0, 8);

  return (
    <div className={cx("flex flex-col gap-1.5 min-w-0", className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-text">
        {label}
      </label>
      <div className={cx("field-input min-h-10 py-1 flex flex-wrap items-center gap-1.5", disabled && "opacity-60")} onClick={() => document.getElementById(id)?.focus()}>
        {value.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-full bg-accent-soft text-accent text-[12.5px] font-medium">
            {tag}
            <button type="button" aria-label={`Remove tag ${tag}`} disabled={disabled} onClick={() => remove(tag)} className="size-5 inline-flex items-center justify-center rounded-full hover:bg-accent/15">
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          disabled={disabled}
          placeholder={value.length === 0 ? placeholder : ""}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => add(draft)}
          className="flex-1 min-w-[120px] h-7 bg-transparent outline-none border-0 text-sm"
        />
      </div>
      {unused.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Tag suggestions">
          {unused.map((s) => (
            <button key={s} type="button" disabled={disabled} onClick={() => add(s)} className="h-7 px-2.5 rounded-full border border-border-strong text-[12px] text-muted hover:text-text hover:bg-panel-alt">
              + {s}
            </button>
          ))}
        </div>
      )}
      {hint && <p className="text-[12.5px] text-muted">{hint}</p>}
    </div>
  );
}
