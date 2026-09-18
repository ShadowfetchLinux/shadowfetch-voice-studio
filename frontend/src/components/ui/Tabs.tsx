import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "@/lib/format";

export interface TabItem<K extends string = string> {
  key: K;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  badge?: ReactNode;
}

export interface TabsProps<K extends string = string> {
  items: TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  /** Visual style: underline (page sections) or pills (toolbars). */
  variant?: "underline" | "pills";
  className?: string;
  /** Optional id prefix so panels can reference tabs (`aria-labelledby`). */
  idPrefix?: string;
}

/** WAI-ARIA tab list with arrow-key navigation. Render the panel yourself with `TabPanel`. */
export function Tabs<K extends string = string>({ items, value, onChange, variant = "underline", className, idPrefix }: TabsProps<K>) {
  const auto = useId();
  const prefix = idPrefix ?? auto;
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = items.filter((i) => !i.disabled);
    const idx = enabled.findIndex((i) => i.key === value);
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % enabled.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = enabled.length - 1;
    else return;
    e.preventDefault();
    const item = enabled[next];
    if (item) {
      onChange(item.key);
      listRef.current?.querySelector<HTMLButtonElement>(`[data-key="${item.key}"]`)?.focus();
    }
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      onKeyDown={onKeyDown}
      className={cx("flex items-center gap-1", variant === "underline" && "border-b border-border", variant === "pills" && "bg-panel-alt p-1 rounded-[var(--radius-control)]", className)}
    >
      {items.map((it) => {
        const selected = it.key === value;
        return (
          <button
            key={it.key}
            type="button"
            role="tab"
            id={`${prefix}-tab-${it.key}`}
            aria-selected={selected}
            aria-controls={`${prefix}-panel-${it.key}`}
            tabIndex={selected ? 0 : -1}
            disabled={it.disabled}
            data-key={it.key}
            onClick={() => onChange(it.key)}
            className={cx(
              "inline-flex items-center gap-2 h-10 px-3 text-sm font-medium whitespace-nowrap transition-colors disabled:opacity-50 [&>svg]:size-4",
              variant === "underline" && "-mb-px border-b-2 rounded-t-[var(--radius-control)]",
              variant === "underline" && (selected ? "border-accent text-accent" : "border-transparent text-muted hover:text-text"),
              variant === "pills" && "rounded-[6px]",
              variant === "pills" && (selected ? "bg-panel text-text shadow-sm" : "text-muted hover:text-text"),
            )}
          >
            {it.icon}
            {it.label}
            {it.badge != null && <span className="ml-0.5 text-[11px] px-1.5 rounded-full bg-black/6 text-muted">{it.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idPrefix, tabKey, active, children, className }: { idPrefix: string; tabKey: string; active: boolean; children: ReactNode; className?: string }) {
  if (!active) return null;
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${tabKey}`} aria-labelledby={`${idPrefix}-tab-${tabKey}`} className={className}>
      {children}
    </div>
  );
}
