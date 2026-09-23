import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cx } from "@/lib/format";
import { Button, IconButton } from "./Button";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Footer content (usually buttons). */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Block closing via Esc / backdrop (e.g. while a job runs). */
  locked?: boolean;
  /** Element to focus on open; defaults to the first focusable element. */
  initialFocusRef?: React.RefObject<HTMLElement>;
}

const sizeClass = { sm: "max-w-[420px]", md: "max-w-[560px]", lg: "max-w-[760px]" };

/** Open dialogs, innermost last: only the top one reacts to Esc / Tab (a confirm can open over another dialog). */
const stack: string[] = [];

/**
 * Accessible modal: role=dialog, aria-modal, labelled by its title, focus trapped inside,
 * Esc + backdrop close (unless `locked`), focus restored to the opener on close.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = "md", locked = false, initialFocusRef }: DialogProps) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // Callers pass inline handlers; reading them through refs keeps the open/focus effect from re-running (and moving
  // focus back to the first control) on every render — e.g. after each keystroke in a field inside the dialog.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const target = initialFocusRef?.current ?? panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
    // Defer so the portal content is laid out before focusing.
    const t = window.setTimeout(() => target?.focus(), 0);

    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape" && !lockedRef.current) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && panel) {
        const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
        if (nodes.length === 0) {
          e.preventDefault();
          panel.focus();
          return;
        }
        const first = nodes[0]!;
        const last = nodes[nodes.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      const at = stack.lastIndexOf(id);
      if (at >= 0) stack.splice(at, 1);
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open, initialFocusRef, id]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 animate-[sfvs-fade-in_120ms_ease-out]" data-testid="dialog-root">
      <div className="absolute inset-0 bg-black/40" onMouseDown={locked ? undefined : onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        tabIndex={-1}
        className={cx("relative w-full panel shadow-[var(--shadow-pop)] flex flex-col max-h-[calc(100vh-48px)] outline-none", sizeClass[size])}
      >
        <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="text-[17px]">
              {title}
            </h2>
            {description && (
              <p id={`${id}-desc`} className="text-muted text-[13px] mt-1">
                {description}
              </p>
            )}
          </div>
          {!locked && (
            <IconButton label="Close" size="sm" onClick={onClose} className="-mr-2 -mt-1">
              <X />
            </IconButton>
          )}
        </header>
        {children && <div className="px-6 pb-4 overflow-y-auto min-h-0">{children}</div>}
        {footer && <footer className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  title: ReactNode;
  /** Body content: explain exactly what will happen. */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
}

/** Yes/no dialog. Focus starts on Cancel for destructive actions so Enter never destroys by accident. */
export function ConfirmDialog({ open, onCancel, onConfirm, title, children, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive, busy }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      locked={busy}
      initialFocusRef={destructive ? (cancelRef as React.RefObject<HTMLElement>) : undefined}
      footer={
        <>
          <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? "danger" : "primary"} onClick={() => void onConfirm()} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children && <div className="text-sm text-text [&_p+p]:mt-2">{children}</div>}
    </Dialog>
  );
}
