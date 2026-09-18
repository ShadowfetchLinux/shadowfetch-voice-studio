import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "@/lib/format";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned header content (buttons, pills). */
  actions?: ReactNode;
  /** Remove body padding (for tables / waveforms that bleed to the edge). */
  flush?: boolean;
  footer?: ReactNode;
  as?: "section" | "div" | "article";
}

/** White panel with optional title row. Use one Card per logical group of controls. */
export function Card({ title, description, actions, flush, footer, as: Tag = "section", className, children, ...rest }: CardProps) {
  const hasHeader = title || description || actions;
  return (
    <Tag className={cx("panel flex flex-col min-w-0", className)} {...rest}>
      {hasHeader && (
        <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-border">
          <div className="min-w-0">
            {title && <h2 className="truncate">{title}</h2>}
            {description && <p className="text-muted text-[13px] mt-0.5">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      <div className={cx("min-w-0 flex-1", !flush && "p-5")}>{children}</div>
      {footer && <footer className="px-5 py-3 border-t border-border bg-panel-alt rounded-b-[var(--radius-panel)]">{footer}</footer>}
    </Tag>
  );
}

/** Alias for readability in page code. */
export const Panel = Card;
