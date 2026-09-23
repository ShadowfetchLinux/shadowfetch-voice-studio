import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Plus, Users } from "lucide-react";
import type { Voice } from "@/lib/protocol";
import { cx } from "@/lib/format";

export interface VoicePickerProps {
  voices: Voice[];
  value: string | null;
  onChange: (voiceId: string) => void;
  onClone: () => void;
  onManage: () => void;
  disabled?: boolean;
}

type Item = { kind: "voice"; voice: Voice } | { kind: "clone" } | { kind: "manage" };

/**
 * Voice menu, like a font menu: the names of your voices, then "Clone New Voice…" and "Manage Voices".
 * Keyboard: Enter/Space/↓ opens, ↑/↓/Home/End move, Enter picks, Esc closes; typing a letter jumps to a name.
 */
export function VoicePicker({ voices, value, onChange, onClone, onManage, disabled }: VoicePickerProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const selected = voices.find((v) => v.id === value) ?? null;
  const items: Item[] = [...voices.map((voice) => ({ kind: "voice" as const, voice })), { kind: "clone" }, { kind: "manage" }];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!listRef.current?.contains(e.target as Node) && !buttonRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [open, active]);

  const openMenu = () => {
    if (disabled) return;
    const i = voices.findIndex((v) => v.id === value);
    setActive(i >= 0 ? i : 0);
    setOpen(true);
  };

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const choose = (item: Item) => {
    close(item.kind === "voice");
    if (item.kind === "voice") onChange(item.voice.id);
    else if (item.kind === "clone") onClone();
    else onManage();
  };

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((i) => (i + 1) % items.length);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + items.length) % items.length);
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(items.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") {
      close(e.key === "Escape");
      if (e.key === "Tab") return;
    } else if (e.key === "Enter" || e.key === " ") {
      const it = items[active];
      if (it) choose(it);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      const n = voices.length;
      for (let step = 1; step <= n; step++) {
        const j = (active + step) % Math.max(1, n);
        if (voices[j]?.name.toLowerCase().startsWith(k)) {
          setActive(j);
          break;
        }
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={selected ? `Voice: ${selected.name}. Change voice` : "Choose a voice"}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openMenu();
          }
        }}
        className={cx(
          "inline-flex items-center justify-between gap-3 h-11 min-w-[220px] max-w-[min(360px,70vw)] pl-4 pr-3 rounded-[var(--radius-control)]",
          "bg-panel border border-border-strong text-[15px] font-medium shadow-sm transition-colors hover:border-accent/60",
          "disabled:opacity-60 disabled:cursor-not-allowed",
        )}
      >
        <span className={cx("truncate", !selected && "text-muted font-normal")}>{selected ? selected.name : voices.length ? "Choose a voice" : "No voices yet"}</span>
        <ChevronDown className={cx("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <ul
          ref={listRef}
          id={menuId}
          role="listbox"
          aria-label="Voices"
          onKeyDown={onListKey}
          className="absolute left-0 top-[calc(100%+6px)] z-40 w-[max(100%,260px)] max-h-[min(420px,60vh)] overflow-y-auto panel shadow-[var(--shadow-pop)] py-1.5 animate-[sfvs-fade-in_90ms_ease-out]"
        >
          {voices.length === 0 && <li className="px-4 py-2 text-[13px] text-muted">You haven't cloned a voice yet.</li>}
          {items.map((it, i) => {
            const isVoice = it.kind === "voice";
            const isSel = isVoice && it.voice.id === value;
            return (
              <li
                key={isVoice ? it.voice.id : it.kind}
                data-index={i}
                role="option"
                aria-selected={isSel}
                tabIndex={-1}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(it)}
                className={cx(
                  "flex items-center gap-3 mx-1.5 px-2.5 h-10 rounded-[6px] cursor-pointer outline-none text-[14px]",
                  i === active && "bg-accent-soft",
                  !isVoice && "text-accent font-medium",
                  it.kind === "clone" && "mt-2 relative before:content-[''] before:absolute before:-top-1 before:-inset-x-1.5 before:h-px before:bg-border",
                )}
              >
                {isVoice ? (
                  <>
                    <span className="size-4 shrink-0 text-accent">{isSel && <Check className="size-4" />}</span>
                    <span className="truncate">{it.voice.name}</span>
                  </>
                ) : it.kind === "clone" ? (
                  <>
                    <Plus className="size-4 shrink-0" /> Clone New Voice…
                  </>
                ) : (
                  <>
                    <Users className="size-4 shrink-0" /> Manage Voices
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
