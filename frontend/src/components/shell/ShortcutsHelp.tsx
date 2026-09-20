import { useEffect } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Feedback";
import { useAppStore, type Page } from "@/store/appStore";
import { NAV_ITEMS, SETTINGS_ITEM } from "./Sidebar";

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  ...NAV_ITEMS.map((n) => ({ keys: [n.key], label: `Go to ${n.label}` })),
  { keys: [SETTINGS_ITEM.key], label: "Go to Settings" },
  { keys: ["n"], label: "New voice" },
  { keys: ["?"], label: "Show this help" },
  { keys: ["Esc"], label: "Close dialogs" },
  { keys: ["Space"], label: "Play / pause (when a player is focused)" },
  { keys: ["←", "→"], label: "Nudge a selected trim handle by 0.05 s" },
  { keys: ["Shift", "←/→"], label: "Nudge by 0.5 s" },
  { keys: ["Ctrl", "Wheel"], label: "Zoom the waveform" },
];

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Global key handling: 1–5 navigate, ? opens help. Ignored while typing or with modifiers. */
export function useGlobalShortcuts() {
  const navigate = useAppStore((s) => s.navigate);
  const setShortcutsOpen = useAppStore((s) => s.setShortcutsOpen);
  useEffect(() => {
    const pages: Record<string, Page> = Object.fromEntries([...NAV_ITEMS, SETTINGS_ITEM].map((n) => [n.key, n.page]));
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        navigate("voices", { action: "new" });
        return;
      }
      const page = pages[e.key];
      if (page) {
        e.preventDefault();
        navigate(page);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, setShortcutsOpen]);
}

export function ShortcutsHelp() {
  const open = useAppStore((s) => s.shortcutsOpen);
  const setOpen = useAppStore((s) => s.setShortcutsOpen);
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" size="sm">
      <ul className="flex flex-col divide-y divide-border">
        {SHORTCUTS.map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-4 py-2 text-sm">
            <span>{s.label}</span>
            <span className="flex items-center gap-1">
              {s.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
