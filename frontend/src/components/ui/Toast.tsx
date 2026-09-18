import { useEffect, type ReactNode } from "react";
import { create } from "zustand";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cx } from "@/lib/format";

export type ToastKind = "success" | "error" | "info" | "warning";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  /** Optional action button (e.g. "Open Settings"). */
  action?: { label: string; onClick: () => void };
  /** ms until auto-dismiss; 0 = sticky (errors default to sticky). */
  timeout: number;
}

export interface ToastInput {
  title: string;
  message?: string;
  action?: Toast["action"];
  timeout?: number;
}

interface ToastState {
  toasts: Toast[];
  push: (kind: ToastKind, input: ToastInput) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

let nextId = 1;

/** Toast queue. Pages should use `toast.*` helpers; the viewport renders the queue. */
export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, input) => {
    const id = nextId++;
    const timeout = input.timeout ?? (kind === "error" ? 0 : kind === "warning" ? 8000 : 4500);
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, timeout, ...input }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

export const toast = {
  success: (title: string, message?: string, extra?: Omit<ToastInput, "title" | "message">) => useToastStore.getState().push("success", { title, message, ...extra }),
  error: (title: string, message?: string, extra?: Omit<ToastInput, "title" | "message">) => useToastStore.getState().push("error", { title, message, ...extra }),
  info: (title: string, message?: string, extra?: Omit<ToastInput, "title" | "message">) => useToastStore.getState().push("info", { title, message, ...extra }),
  warning: (title: string, message?: string, extra?: Omit<ToastInput, "title" | "message">) => useToastStore.getState().push("warning", { title, message, ...extra }),
  dismiss: (id: number) => useToastStore.getState().dismiss(id),
};

const icons: Record<ToastKind, ReactNode> = {
  success: <CheckCircle2 className="size-5 text-success" />,
  error: <XCircle className="size-5 text-danger" />,
  info: <Info className="size-5 text-accent" />,
  warning: <AlertTriangle className="size-5 text-warn" />,
};

function ToastItem({ t, onDismiss }: { t: Toast; onDismiss: () => void }) {
  useEffect(() => {
    if (!t.timeout) return;
    const h = window.setTimeout(onDismiss, t.timeout);
    return () => window.clearTimeout(h);
  }, [t.timeout, onDismiss]);
  return (
    <div
      role={t.kind === "error" ? "alert" : "status"}
      className={cx(
        "pointer-events-auto flex items-start gap-3 w-[360px] max-w-[calc(100vw-32px)] panel shadow-[var(--shadow-pop)] px-4 py-3",
        "animate-[sfvs-toast-in_160ms_ease-out]",
        t.kind === "error" && "border-danger/40",
      )}
    >
      <span className="shrink-0 mt-0.5">{icons[t.kind]}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium break-words">{t.title}</p>
        {t.message && <p className="text-[12.5px] text-muted mt-0.5 break-words whitespace-pre-line">{t.message}</p>}
        {t.action && (
          <button type="button" onClick={t.action.onClick} className="mt-2 text-[13px] font-medium text-accent hover:text-accent-hover">
            {t.action.label}
          </button>
        )}
      </div>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="shrink-0 -mr-1 -mt-0.5 size-8 inline-flex items-center justify-center rounded-md text-muted hover:text-text hover:bg-black/5">
        <X className="size-4" />
      </button>
    </div>
  );
}

/** Renders the toast queue in the bottom-right corner. Mount once in the app shell. */
export function ToastProvider() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2 items-end">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}
