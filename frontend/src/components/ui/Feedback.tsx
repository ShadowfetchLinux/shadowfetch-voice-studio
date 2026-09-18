import { useId, useState, type HTMLAttributes, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cx, percent } from "@/lib/format";

// ---------------------------------------------------------------------------
// ProgressBar
// ---------------------------------------------------------------------------

export interface ProgressBarProps {
  /** Measured count so far; omit for indeterminate. */
  current?: number | null;
  total?: number | null;
  /** Unit noun for the caption ("segments", "files"); when set the caption reads "3 of 12 segments". */
  unit?: string;
  /** Text shown left of the count (stage/message). */
  label?: ReactNode;
  /** Custom caption for the right side (overrides "x of y"). */
  caption?: ReactNode;
  size?: "sm" | "md";
  tone?: "accent" | "success" | "warn" | "danger";
  className?: string;
}

const toneClass = { accent: "bg-accent", success: "bg-success", warn: "bg-warn", danger: "bg-danger" };

/** Determinate bar with an "N of M" caption from measured counts, or an indeterminate sweep when counts are unknown. */
export function ProgressBar({ current, total, unit, label, caption, size = "md", tone = "accent", className }: ProgressBarProps) {
  const pct = percent(current, total);
  const indeterminate = pct == null;
  const captionText = caption ?? (!indeterminate ? `${current} of ${total}${unit ? ` ${unit}` : ""}` : null);
  return (
    <div className={cx("flex flex-col gap-1.5 min-w-0", className)}>
      {(label || captionText) && (
        <div className="flex items-center justify-between gap-3 text-[12.5px]">
          <span className="text-text truncate">{label}</span>
          {captionText && <span className="text-muted tabular-nums shrink-0">{captionText}</span>}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={indeterminate ? undefined : (total as number)}
        aria-valuenow={indeterminate ? undefined : (current as number)}
        aria-valuetext={indeterminate ? "Working" : String(captionText)}
        className={cx("relative w-full overflow-hidden rounded-full bg-black/8", size === "sm" ? "h-1.5" : "h-2.5")}
      >
        {indeterminate ? (
          <div className={cx("absolute inset-y-0 w-1/3 rounded-full animate-[sfvs-indeterminate_1.4s_ease-in-out_infinite]", toneClass[tone])} />
        ) : (
          <div className={cx("h-full rounded-full transition-[width] duration-200", toneClass[tone])} style={{ width: `${pct}%` }} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusPill
// ---------------------------------------------------------------------------

export type PillTone = "neutral" | "success" | "warn" | "danger" | "accent" | "dark";

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
  /** Coloured dot on the left; `pulse` animates it (running/loading states). */
  dot?: boolean;
  pulse?: boolean;
  icon?: ReactNode;
  size?: "sm" | "md";
}

const pillTone: Record<PillTone, string> = {
  neutral: "bg-black/6 text-text",
  success: "bg-success-soft text-success",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  accent: "bg-accent-soft text-accent",
  dark: "bg-sidebar-active text-sidebar-text",
};
const dotTone: Record<PillTone, string> = {
  neutral: "bg-muted",
  success: "bg-success",
  warn: "bg-warn",
  danger: "bg-danger",
  accent: "bg-accent",
  dark: "bg-sidebar-text",
};

/** Compact status label. Colour is tone-based; always pair with text (never colour alone). */
export function StatusPill({ tone = "neutral", dot, pulse, icon, size = "md", className, children, ...rest }: StatusPillProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap max-w-full",
        size === "sm" ? "h-6 px-2 text-[11.5px]" : "h-7 px-2.5 text-[12.5px]",
        "[&>svg]:size-3.5 [&>svg]:shrink-0",
        pillTone[tone],
        className,
      )}
      {...rest}
    >
      {dot && <span aria-hidden className={cx("size-1.5 rounded-full shrink-0", dotTone[tone], pulse && "animate-[sfvs-pulse_1.2s_ease-in-out_infinite]")} />}
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  text?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

/** Centered placeholder for empty lists / not-yet-configured areas. */
export function EmptyState({ icon, title, text, action, className, compact }: EmptyStateProps) {
  return (
    <div className={cx("flex flex-col items-center justify-center text-center", compact ? "py-6 px-4" : "py-12 px-6", className)}>
      {icon && <div className="mb-3 text-muted [&>svg]:size-8 [&>svg]:stroke-[1.5]">{icon}</div>}
      <h3 className="text-[15px]">{title}</h3>
      {text && <p className="text-muted text-[13px] mt-1 max-w-[46ch]">{text}</p>}
      {action && <div className="mt-4 flex gap-2">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  className?: string;
}

/** Simple hover/focus tooltip (no positioning library). The child must be focusable for keyboard users. */
export function Tooltip({ content, children, side = "top", className }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span
      className={cx("relative inline-flex", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          id={id}
          className={cx(
            "absolute left-1/2 -translate-x-1/2 z-40 whitespace-nowrap rounded-md bg-sidebar text-sidebar-text text-[12px] px-2 py-1 shadow-[var(--shadow-pop)] pointer-events-none",
            side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Kbd
// ---------------------------------------------------------------------------

/** Keyboard key cap. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cx("inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-[5px] border border-border-strong bg-panel-alt text-[11.5px] text-text shadow-[inset_0_-1px_0_var(--color-border-strong)]", className)}>
      {children}
    </kbd>
  );
}

// ---------------------------------------------------------------------------
// Collapsible
// ---------------------------------------------------------------------------

export interface CollapsibleProps {
  title: ReactNode;
  description?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}

/** Disclosure section for advanced settings. */
export function Collapsible({ title, description, defaultOpen = false, open: controlled, onOpenChange, children, className }: CollapsibleProps) {
  const id = useId();
  const [internal, setInternal] = useState(defaultOpen);
  const open = controlled ?? internal;
  const toggle = () => {
    const next = !open;
    setInternal(next);
    onOpenChange?.(next);
  };
  return (
    <div className={cx("panel", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={toggle}
        className="w-full flex items-center gap-3 px-5 py-4 text-left rounded-[var(--radius-panel)] hover:bg-panel-alt"
      >
        <ChevronRight className={cx("size-4 text-muted transition-transform", open && "rotate-90")} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold">{title}</span>
          {description && <span className="block text-[13px] text-muted mt-0.5">{description}</span>}
        </span>
      </button>
      {open && (
        <div id={`${id}-body`} className="px-5 pb-5 pt-1 border-t border-border">
          {children}
        </div>
      )}
    </div>
  );
}
