/**
 * Saved voices, shared by the Speak voice menu, the Voices screen and the clone flow — one list, so a voice created
 * or renamed anywhere shows up everywhere at once.
 */
import { create } from "zustand";
import { api } from "@/lib/api";
import type { Reference, Voice } from "@/lib/protocol";
import { logWorkerError } from "@/lib/friendlyErrors";

interface VoicesState {
  voices: Voice[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  load: () => Promise<Voice[]>;
  /** Insert or replace one voice (after create / rename / edit). */
  upsert: (voice: Voice) => void;
  remove: (id: string) => void;
}

let inflight: Promise<Voice[]> | null = null;

export const useVoicesStore = create<VoicesState>((set, get) => ({
  voices: [],
  loaded: false,
  loading: false,
  error: null,

  load() {
    if (inflight) return inflight;
    set({ loading: true });
    inflight = api.voices
      .list()
      .then((r) => {
        set({ voices: r.voices, loaded: true, loading: false, error: null });
        return r.voices;
      })
      .catch((err) => {
        logWorkerError("voices.list", err);
        set({ loading: false, loaded: true, error: "Your voices couldn't be loaded." });
        return get().voices;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  },

  upsert(voice) {
    set((s) => {
      const i = s.voices.findIndex((v) => v.id === voice.id);
      if (i < 0) return { voices: [voice, ...s.voices] };
      const next = [...s.voices];
      next[i] = { ...next[i], ...voice };
      return { voices: next };
    });
  },

  remove(id) {
    set((s) => ({ voices: s.voices.filter((v) => v.id !== id) }));
  },
}));

/** The reference a voice speaks with: its selected one, else its newest. */
export function activeReference(voice: Voice | null | undefined): Reference | null {
  const refs = voice?.references ?? [];
  return refs.find((r) => r.id === voice?.selected_reference_id) ?? refs[refs.length - 1] ?? null;
}

/** Seconds of the voice's active sample (its trimmed reference). */
export function sampleSeconds(voice: Voice | null | undefined): number | null {
  const r = activeReference(voice);
  return r ? Math.max(0, r.end_s - r.start_s) : null;
}

/** The audio file the active sample is cut from (decoded working copy, else the original). */
export function sampleAudioPath(ref: Reference | null | undefined): string | null {
  return ref?.asset?.working_path ?? ref?.asset?.original_path ?? null;
}

export function __resetVoicesStore(): void {
  inflight = null;
  useVoicesStore.setState({ voices: [], loaded: false, loading: false, error: null });
}
