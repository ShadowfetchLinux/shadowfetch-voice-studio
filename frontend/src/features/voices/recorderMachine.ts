/**
 * Pure state machine for the microphone recorder (no React, no API — unit-testable).
 *
 * Phases follow the worker session lifecycle (record.start → pause/resume → stop | discard) plus the
 * transitional states the UI needs while a request is in flight. Levels and elapsed time come only from
 * `record.level` events (measured by the worker); nothing is extrapolated locally.
 */
import type { AudioStats, RecordLevel, RecordNegotiated, RecordStartResult, RecordStateEvent, RecordStopResult } from "@/lib/protocol";

export type RecorderPhase = "idle" | "starting" | "recording" | "paused" | "stopping" | "error";

export interface RecorderError {
  code: string;
  message: string;
  recoverable: boolean;
  /** Which request failed (start/pause/resume/stop) or "session" for a worker-reported failure. */
  during: "start" | "pause" | "resume" | "stop" | "discard" | "session";
}

/** A finished recording kept in the takes list (the worker registered it as a `reference` asset). */
export interface RecorderTake {
  asset_id: string;
  session_id: string;
  path: string;
  working_path: string | null;
  duration_s: number;
  stats: AudioStats | null;
  negotiated: RecordNegotiated;
  script_id: string | null;
  take_number: number;
  /** Worker-reported notes (precision note, monitoring disabled, decode warnings). */
  notes: string[];
  created_at: number;
}

/** `record.start` result as the worker actually returns it (superset of the PROTOCOL shape). */
export type RecorderStartResult = RecordStartResult & {
  negotiated: RecordNegotiated & { backend?: string; precision_note?: string; device_index?: number | null };
  monitoring?: boolean;
  script_id?: string | null;
  take_number?: number | null;
};

export type RecorderStopResult = Omit<RecordStopResult, "asset_id"> & {
  /** Null when nothing usable was written (the worker then adds a note instead of an asset). */
  asset_id?: string | null;
  working_path?: string | null;
  notes?: string[];
  script_id?: string | null;
  take_number?: number | null;
  error?: { code: string; message: string } | null;
};

export interface RecorderState {
  phase: RecorderPhase;
  sessionId: string | null;
  negotiated: RecorderStartResult["negotiated"] | null;
  notes: string[];
  /** Whether the worker is playing the microphone back (`settings.monitor_input`). */
  monitoring: boolean;
  level: RecordLevel | null;
  /** Seconds captured so far, from the last level event. */
  elapsed_s: number;
  /** Any clip reported during this session (latched until the next session). */
  clippedInSession: boolean;
  error: RecorderError | null;
  takes: RecorderTake[];
  nextTakeNumber: number;
}

export type RecorderEvent =
  | { type: "start" }
  | { type: "started"; result: RecorderStartResult }
  | { type: "pause" }
  | { type: "paused" }
  | { type: "resume" }
  | { type: "resumed" }
  | { type: "stop" }
  | { type: "stopped"; result: RecorderStopResult }
  | { type: "discarded" }
  | { type: "failed"; error: RecorderError }
  | { type: "level"; data: RecordLevel }
  | { type: "sessionState"; data: RecordStateEvent }
  | { type: "removeTake"; asset_id: string }
  | { type: "clearError" }
  | { type: "reset" };

export const initialRecorderState: RecorderState = {
  phase: "idle",
  sessionId: null,
  negotiated: null,
  notes: [],
  monitoring: false,
  level: null,
  elapsed_s: 0,
  clippedInSession: false,
  error: null,
  takes: [],
  nextTakeNumber: 1,
};

/** True while the microphone is open (recording or paused) or a transition is in flight. */
export function isSessionActive(phase: RecorderPhase): boolean {
  return phase === "starting" || phase === "recording" || phase === "paused" || phase === "stopping";
}

/** `record.state` carries only a reason string; map the well-known worker wording to a stable code. */
function sessionErrorCode(reason: string): string {
  if (/DISK_FULL|no space left|ENOSPC|disk filled/i.test(reason)) return "DISK_FULL";
  if (/DEVICE_UNAVAILABLE|device|stream|PortAudio|pulse/i.test(reason)) return "DEVICE_UNAVAILABLE";
  return "INTERNAL";
}

function endSession(s: RecorderState, phase: RecorderPhase): RecorderState {
  return { ...s, phase, sessionId: null, negotiated: null, notes: [], level: null, elapsed_s: 0, clippedInSession: false };
}

/** Reducer for the recorder. Unknown/illegal transitions are ignored (returns the same state). */
export function recorderReducer(s: RecorderState, e: RecorderEvent): RecorderState {
  switch (e.type) {
    case "start":
      if (isSessionActive(s.phase)) return s;
      return { ...s, phase: "starting", error: null, level: null, elapsed_s: 0, clippedInSession: false };
    case "started":
      if (s.phase !== "starting") return s;
      return {
        ...s,
        phase: "recording",
        sessionId: e.result.session_id,
        negotiated: e.result.negotiated,
        notes: e.result.notes ?? [],
        monitoring: e.result.monitoring ?? false,
      };
    case "pause":
      return s.phase === "recording" ? { ...s, phase: "paused" } : s;
    case "paused":
      return s.phase === "recording" || s.phase === "paused" ? { ...s, phase: "paused" } : s;
    case "resume":
      return s.phase === "paused" ? { ...s, phase: "recording" } : s;
    case "resumed":
      return s.phase === "paused" || s.phase === "recording" ? { ...s, phase: "recording" } : s;
    case "stop":
      return s.phase === "recording" || s.phase === "paused" || s.phase === "error" ? { ...s, phase: "stopping" } : s;
    case "stopped": {
      const r = e.result;
      const next = endSession(s, "idle");
      if (!r.asset_id || !(r.duration_s > 0)) {
        // nothing usable on disk — the worker says so in its notes; keep them visible as a non-fatal error
        const note = (r.notes ?? []).find((n) => /no audio/i.test(n)) ?? "No audio was written, so nothing was kept.";
        return { ...next, error: { code: "EMPTY_AUDIO", message: note, recoverable: true, during: "stop" } };
      }
      const take: RecorderTake = {
        asset_id: r.asset_id,
        session_id: r.session_id,
        path: r.path,
        working_path: r.working_path ?? null,
        duration_s: r.duration_s,
        stats: r.stats ?? null,
        negotiated: r.negotiated,
        script_id: r.script_id ?? null,
        take_number: r.take_number ?? s.nextTakeNumber,
        notes: r.notes ?? [],
        created_at: Date.now(),
      };
      return { ...next, takes: [...s.takes, take], nextTakeNumber: Math.max(s.nextTakeNumber, take.take_number) + 1 };
    }
    case "discarded":
      return endSession(s, "idle");
    case "failed":
      if (e.error.during === "start" || e.error.during === "discard") return { ...endSession(s, "error"), error: e.error };
      if (e.error.during === "stop") return { ...s, phase: "error", error: e.error }; // session still open: keep id for retry/discard
      // pause/resume failed: the session is unchanged; surface the error and let the phase events tell the truth
      return { ...s, phase: s.phase === "paused" && e.error.during === "pause" ? "recording" : s.phase === "recording" && e.error.during === "resume" ? "paused" : s.phase, error: e.error };
    case "level":
      if (!s.sessionId || e.data.session_id !== s.sessionId) return s;
      if (s.phase !== "recording" && s.phase !== "paused" && s.phase !== "stopping") return s;
      return { ...s, level: e.data, elapsed_s: e.data.elapsed_s, clippedInSession: s.clippedInSession || e.data.clipped };
    case "sessionState": {
      if (!s.sessionId || e.data.session_id !== s.sessionId) return s;
      if (e.data.state === "error") {
        const reason = e.data.reason ?? "The audio device stopped delivering audio.";
        return { ...s, phase: "error", error: { code: sessionErrorCode(reason), message: reason, recoverable: true, during: "session" } };
      }
      if (e.data.state === "stopped" && e.data.reason && /error/i.test(e.data.reason) && s.phase !== "stopping") {
        return { ...s, phase: "error", error: { code: sessionErrorCode(e.data.reason), message: e.data.reason, recoverable: true, during: "session" } };
      }
      if (e.data.state === "paused" && s.phase === "recording") return { ...s, phase: "paused" };
      if (e.data.state === "recording" && s.phase === "paused") return { ...s, phase: "recording" };
      return s;
    }
    case "removeTake":
      return { ...s, takes: s.takes.filter((t) => t.asset_id !== e.asset_id) };
    case "clearError":
      return { ...s, error: null, phase: s.phase === "error" && !s.sessionId ? "idle" : s.phase };
    case "reset":
      return { ...initialRecorderState, takes: s.takes, nextTakeNumber: s.nextTakeNumber };
    default:
      return s;
  }
}

