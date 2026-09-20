import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { clamp } from "@/lib/format";
import type { Selection } from "./waveformMath";

export interface UsePlayerOptions {
  /** Absolute local file path; converted through the Tauri asset protocol. */
  path?: string | null;
  /** Already-resolved URL (takes precedence over `path`). */
  src?: string | null;
  /** When set together with `restrictToSelection`, playback is confined to this range. */
  selection?: Selection | null;
  /** Start value for restrict-to-selection. */
  restrictToSelection?: boolean;
  /** Start value for looping the selection. */
  loop?: boolean;
  onEnded?: () => void;
}

export interface Player {
  audio: HTMLAudioElement | null;
  ready: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  error: string | null;
  loop: boolean;
  restrictToSelection: boolean;
  play: () => Promise<void>;
  pause: () => void;
  toggle: () => Promise<void>;
  /** Seek in seconds (clamped). */
  seek: (t: number) => void;
  /** Seek to the selection start and play (restricted to the selection). */
  playSelection: () => Promise<void>;
  setVolume: (v: number) => void;
  setLoop: (loop: boolean) => void;
  setRestrictToSelection: (on: boolean) => void;
}

/**
 * HTMLAudioElement wrapper for local files. Uses requestAnimationFrame while playing so the
 * playhead and selection boundary are checked at display rate (timeupdate is only ~4 Hz).
 */
export function usePlayer(opts: UsePlayerOptions = {}): Player {
  const { path, src, selection, onEnded } = opts;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const selRef = useRef<Selection | null>(selection ?? null);
  selRef.current = selection ?? null;

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loop, setLoop] = useState(opts.loop ?? false);
  const [restrictToSelection, setRestrictToSelection] = useState(opts.restrictToSelection ?? false);
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const restrictRef = useRef(restrictToSelection);
  restrictRef.current = restrictToSelection;

  // Explicit `src` is used verbatim; a `path` is resolved to a playable (blob) URL asynchronously.
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(src ?? null);
  useEffect(() => {
    let cancelled = false;
    if (src) {
      setResolvedSrc(src);
      return;
    }
    if (!path) {
      setResolvedSrc(null);
      return;
    }
    const p = path;
    api.shell
      .mediaSrc(p)
      .then((url) => {
        if (cancelled) api.shell.releaseMediaSrc(p);
        else setResolvedSrc(url);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`The audio file could not be loaded: ${(err as { message?: string })?.message ?? String(err)}`);
      });
    return () => {
      cancelled = true;
      api.shell.releaseMediaSrc(p);
    };
  }, [src, path]);

  // Create the element once.
  useEffect(() => {
    const a = new Audio();
    a.preload = "metadata";
    audioRef.current = a;
    const onMeta = () => {
      setDuration(Number.isFinite(a.duration) ? a.duration : 0);
      setReady(true);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnd = () => {
      setPlaying(false);
      onEnded?.();
    };
    const onErr = () => {
      const codes: Record<number, string> = { 1: "playback aborted", 2: "network error while reading the file", 3: "the file could not be decoded", 4: "the source is not supported or was blocked (asset protocol / CSP)" };
      const code = a.error?.code ?? 0;
      setError(`The audio file could not be loaded: ${codes[code] ?? "unknown error"}${a.error?.message ? ` — ${a.error.message}` : ""}`);
    };
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("durationchange", onMeta);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEnd);
    a.addEventListener("error", onErr);
    return () => {
      a.pause();
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("durationchange", onMeta);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("error", onErr);
      a.removeAttribute("src");
      a.load();
      audioRef.current = null;
    };
    // onEnded is read once on purpose; callers pass stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap source when the file changes.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    setReady(false);
    setError(null);
    setCurrentTime(0);
    setDuration(0);
    if (resolvedSrc) {
      a.src = resolvedSrc;
      a.load();
    } else {
      a.removeAttribute("src");
      a.load();
    }
  }, [resolvedSrc]);

  // Display-rate tick while playing: playhead + selection end enforcement.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    const tick = () => {
      const t = a.currentTime;
      const sel = selRef.current;
      if (restrictRef.current && sel && t >= sel.end - 0.005) {
        if (loopRef.current) {
          a.currentTime = sel.start;
        } else {
          a.pause();
          a.currentTime = sel.end;
          setCurrentTime(sel.end);
          return;
        }
      }
      setCurrentTime(a.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing]);

  const seek = useCallback((t: number) => {
    const a = audioRef.current;
    if (!a) return;
    const d = Number.isFinite(a.duration) ? a.duration : 0;
    const v = d > 0 ? clamp(t, 0, d) : Math.max(0, t);
    a.currentTime = v;
    setCurrentTime(v);
  }, []);

  const play = useCallback(async () => {
    const a = audioRef.current;
    if (!a) return;
    const sel = selRef.current;
    if (restrictRef.current && sel && (a.currentTime < sel.start || a.currentTime >= sel.end - 0.005)) {
      a.currentTime = sel.start;
    }
    try {
      await a.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Playback failed");
    }
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const toggle = useCallback(async () => {
    if (audioRef.current?.paused) await play();
    else pause();
  }, [play, pause]);

  const playSelection = useCallback(async () => {
    const sel = selRef.current;
    if (!sel) return play();
    restrictRef.current = true;
    setRestrictToSelection(true);
    seek(sel.start);
    await play();
  }, [play, seek]);

  const setVolume = useCallback((v: number) => {
    const vv = clamp(v, 0, 1);
    if (audioRef.current) audioRef.current.volume = vv;
    setVolumeState(vv);
  }, []);

  return {
    audio: audioRef.current,
    ready,
    playing,
    currentTime,
    duration,
    volume,
    error,
    loop,
    restrictToSelection,
    play,
    pause,
    toggle,
    seek,
    playSelection,
    setVolume,
    setLoop,
    setRestrictToSelection,
  };
}
