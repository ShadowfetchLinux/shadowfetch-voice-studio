/**
 * Opens the Clone Voice flow from anywhere (Speak's voice menu, the Voices screen, empty states).
 * The dialog itself lives once in the app shell.
 */
import { create } from "zustand";

export type CloneMode =
  /** A brand-new voice. */
  | { kind: "new" }
  /** Another recording for an existing voice (becomes the one it speaks with). */
  | { kind: "addRecording"; voiceId: string };

/** Where the flow was opened: from Speak / Voices the new voice is selected on Speak and Speak is shown; from the
 *  project editor the user stays there and the editor picks the new voice up. */
export type CloneOrigin = "speak" | "editor";

interface CloneState {
  open: boolean;
  mode: CloneMode;
  origin: CloneOrigin;
  /** Increments per open so the dialog always starts fresh. */
  session: number;
  start: (mode?: CloneMode, origin?: CloneOrigin) => void;
  close: () => void;
}

export const useCloneStore = create<CloneState>((set) => ({
  open: false,
  mode: { kind: "new" },
  origin: "speak",
  session: 0,
  start: (mode = { kind: "new" }, origin = "speak") => set((s) => ({ open: true, mode, origin, session: s.session + 1 })),
  close: () => set({ open: false }),
}));
