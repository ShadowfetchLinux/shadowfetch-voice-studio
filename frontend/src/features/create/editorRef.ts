/**
 * Tiny registry so the tag palette (right column) can insert at the cursor of the script editor (left
 * column) and the master player can be toggled from the keyboard without prop-drilling refs.
 */
import { insertToken } from "./planMath";
import { useCreateStore } from "./createStore";

let editorEl: HTMLTextAreaElement | null = null;
let masterToggle: (() => void) | null = null;

export function registerEditor(el: HTMLTextAreaElement | null): void {
  editorEl = el;
}

export function registerMasterToggle(fn: (() => void) | null): void {
  masterToggle = fn;
}

/** Toggle master playback if a master player is mounted. Returns false when there is none. */
export function toggleMasterPlayback(): boolean {
  if (!masterToggle) return false;
  masterToggle();
  return true;
}

/** Insert a tag token at the editor cursor (or at the end when the editor is not mounted) and refocus it. */
export function insertTokenAtCursor(token: string): void {
  const store = useCreateStore.getState();
  const text = store.script;
  const sel = editorEl ? { start: editorEl.selectionStart, end: editorEl.selectionEnd } : { start: text.length, end: text.length };
  const next = insertToken(text, token, sel);
  store.setScript(next.text);
  if (editorEl) {
    const el = editorEl;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.cursor, next.cursor);
      store.setSelection({ start: next.cursor, end: next.cursor });
    });
  }
}
