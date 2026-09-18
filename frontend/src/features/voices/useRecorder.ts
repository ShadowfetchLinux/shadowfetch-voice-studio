/**
 * React hook that drives `recorderReducer` with the worker's record.* methods and events.
 * All state changes go through the reducer so the machine stays testable without React.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import { api } from "@/lib/api";
import type { RecordStartParams } from "@/lib/protocol";
import { WorkerError } from "@/lib/protocol";
import {
  initialRecorderState,
  isSessionActive,
  recorderReducer,
  type RecorderError,
  type RecorderEvent,
  type RecorderStartResult,
  type RecorderState,
  type RecorderStopResult,
} from "./recorderMachine";

export interface RecorderOptions {
  /** Input device index (null = worker/settings default). */
  deviceIndex: number | null;
  /** Guided script the user is reading (stored with the recording). */
  scriptId: string | null;
  sessionName?: string;
}

export interface Recorder {
  state: RecorderState;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  discard: () => Promise<void>;
  removeTake: (asset_id: string) => void;
  clearError: () => void;
  dispatch: (e: RecorderEvent) => void;
}

function toRecorderError(err: unknown, during: RecorderError["during"]): RecorderError {
  const we = WorkerError.from(err);
  return { code: we.code, message: we.message, recoverable: we.recoverable, during };
}

/** Recorder state + actions bound to the worker. Subscribes to `record.level` / `record.state` while mounted. */
export function useRecorder(opts: RecorderOptions): Recorder {
  const [state, dispatch] = useReducer(recorderReducer, initialRecorderState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const offLevel = api.events.on("record.level", (d) => dispatch({ type: "level", data: d }));
    const offState = api.events.on("record.state", (d) => dispatch({ type: "sessionState", data: d }));
    return () => {
      offLevel();
      offState();
    };
  }, []);

  // Never leave the microphone open when the recorder unmounts (page change): discard an unfinished session.
  useEffect(
    () => () => {
      const s = stateRef.current;
      if (s.sessionId && isSessionActive(s.phase)) void api.record.discard(s.sessionId).catch(() => undefined);
    },
    [],
  );

  const start = useCallback(async () => {
    const s = stateRef.current;
    if (isSessionActive(s.phase)) return;
    dispatch({ type: "start" });
    const o = optsRef.current;
    // The worker also accepts script_id / take_number (stored with the recording); they are not in the PROTOCOL params type.
    const params: RecordStartParams & { script_id?: string | null; take_number?: number } = {
      device_index: o.deviceIndex,
      channels: 1,
      session_name: o.sessionName,
      script_id: o.scriptId,
      take_number: s.nextTakeNumber,
    };
    try {
      const result = (await api.record.start(params)) as RecorderStartResult;
      dispatch({ type: "started", result });
    } catch (err) {
      dispatch({ type: "failed", error: toRecorderError(err, "start") });
    }
  }, []);

  const pause = useCallback(async () => {
    const s = stateRef.current;
    if (!s.sessionId || s.phase !== "recording") return;
    dispatch({ type: "pause" });
    try {
      await api.record.pause(s.sessionId);
      dispatch({ type: "paused" });
    } catch (err) {
      dispatch({ type: "failed", error: toRecorderError(err, "pause") });
    }
  }, []);

  const resume = useCallback(async () => {
    const s = stateRef.current;
    if (!s.sessionId || s.phase !== "paused") return;
    dispatch({ type: "resume" });
    try {
      await api.record.resume(s.sessionId);
      dispatch({ type: "resumed" });
    } catch (err) {
      dispatch({ type: "failed", error: toRecorderError(err, "resume") });
    }
  }, []);

  const stop = useCallback(async () => {
    const s = stateRef.current;
    if (!s.sessionId || !(s.phase === "recording" || s.phase === "paused" || s.phase === "error")) return;
    dispatch({ type: "stop" });
    try {
      const result = (await api.record.stop(s.sessionId)) as RecorderStopResult;
      dispatch({ type: "stopped", result });
    } catch (err) {
      dispatch({ type: "failed", error: toRecorderError(err, "stop") });
    }
  }, []);

  const discard = useCallback(async () => {
    const s = stateRef.current;
    if (!s.sessionId) {
      dispatch({ type: "discarded" });
      return;
    }
    try {
      await api.record.discard(s.sessionId);
      dispatch({ type: "discarded" });
    } catch (err) {
      dispatch({ type: "failed", error: toRecorderError(err, "discard") });
    }
  }, []);

  const removeTake = useCallback((asset_id: string) => dispatch({ type: "removeTake", asset_id }), []);
  const clearError = useCallback(() => dispatch({ type: "clearError" }), []);

  return { state, start, pause, resume, stop, discard, removeTake, clearError, dispatch };
}
