import type { TagSpec } from "@/lib/protocol";
import { insertTokenAtCursor } from "../editorRef";

export interface TagPaletteProps {
  /** `Capabilities.tags`; nothing renders when empty. */
  tags: readonly TagSpec[];
  disabled?: boolean;
}

/** Paralinguistic tags the engine declared (e.g. `[laugh]`). Clicking inserts the token at the editor cursor. */
export function TagPalette({ tags, disabled }: TagPaletteProps) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="tag-palette">
      <div>
        <h3 className="text-[13px] font-medium">Expression tags</h3>
        <p className="text-[12.5px] text-muted mt-0.5">Declared by the engine. Click to insert at the cursor.</p>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Expression tags">
        {tags.map((t) => (
          <button
            key={t.token}
            type="button"
            disabled={disabled}
            title={t.description || t.token}
            onClick={() => insertTokenAtCursor(t.token)}
            className="h-8 px-2.5 rounded-full border border-border-strong bg-panel text-[12.5px] font-medium hover:bg-panel-alt disabled:opacity-55 disabled:cursor-not-allowed"
          >
            {t.label} <code className="text-muted ml-1">{t.token}</code>
          </button>
        ))}
      </div>
    </div>
  );
}
