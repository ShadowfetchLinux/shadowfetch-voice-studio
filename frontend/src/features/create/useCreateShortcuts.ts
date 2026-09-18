import { useEffect } from "react";
import { useCreateStore } from "./createStore";
import { toggleMasterPlayback } from "./editorRef";

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/**
 * Create-page keys: Ctrl+Enter = Generate full, Ctrl+Shift+Enter = Generate preview (both also inside the
 * editor), Esc = ask to cancel a running job, Space = toggle master playback when no control is focused.
 * Dialogs stop Esc before it reaches here (see Dialog.tsx).
 */
export function useCreateShortcuts(onRequestCancel: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useCreateStore.getState();
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        if (!s.projectId || s.job) return;
        void s.generate({ mode: e.shiftKey ? "preview" : "full" });
        return;
      }
      if (e.key === "Escape") {
        if (s.job && !s.job.cancelling && !document.querySelector('[role="dialog"]')) {
          e.preventDefault();
          onRequestCancel();
        }
        return;
      }
      if (e.key === " " && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) {
        if (document.querySelector('[role="dialog"]')) return;
        if (e.target instanceof HTMLButtonElement) return; // let buttons activate normally
        if (toggleMasterPlayback()) e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRequestCancel]);
}
