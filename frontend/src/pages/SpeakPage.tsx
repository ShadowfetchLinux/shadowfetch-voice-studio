import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, Lock, Plus, Square, X } from "lucide-react";
import { cx } from "@/lib/format";
import type { FriendlyAction } from "@/lib/friendlyErrors";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Feedback";
import { Spinner } from "@/components/ui/Spinner";
import { useAppStore } from "@/store/appStore";
import { ensureModels } from "@/store/modelSetup";
import { useVoicesStore } from "@/store/voicesStore";
import { stepLabel, useSpeakStore } from "@/features/speak/speakStore";
import { VoicePicker } from "@/features/speak/VoicePicker";
import { SpeechPlayer } from "@/features/speak/SpeechPlayer";
import { RecentList } from "@/features/speak/RecentList";
import { useCloneStore } from "@/features/voices/cloneStore";
import { EST_CHARS_PER_SECOND, wordCount } from "@/features/create/planMath";

function estimate(text: string): string {
  const words = wordCount(text);
  if (!words) return "";
  const secs = Math.max(1, Math.round(text.trim().length / EST_CHARS_PER_SECOND));
  const len = secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)} min ${secs % 60 ? `${secs % 60} s` : ""}`.trim();
  return `${words} word${words === 1 ? "" : "s"} · about ${len}`;
}

function isInDialog(el: EventTarget | null): boolean {
  return el instanceof Element && !!el.closest('[role="dialog"]');
}

/**
 * Speak: a voice menu, a large text editor, one Speak button, and the result right below it.
 * Ctrl+Enter speaks; Esc stops. Everything else (planning, sentences, engine, assembly) happens underneath.
 */
export default function SpeakPage() {
  const navigate = useAppStore((s) => s.navigate);
  const ready = useSpeakStore((s) => s.ready);
  const loadError = useSpeakStore((s) => s.loadError);
  const text = useSpeakStore((s) => s.text);
  const saveState = useSpeakStore((s) => s.saveState);
  const voiceId = useSpeakStore((s) => s.voiceId);
  const run = useSpeakStore((s) => s.run);
  const error = useSpeakStore((s) => s.error);
  const needsVoice = useSpeakStore((s) => s.needsVoice);
  const current = useSpeakStore((s) => s.current);
  const history = useSpeakStore((s) => s.history);
  const playRequest = useSpeakStore((s) => s.playRequest);
  const { init, setText, setVoice, speak, cancel, play, consumePlay, forget, loadHistory, dismissError, flushText } = useSpeakStore.getState();
  const allVoices = useVoicesStore((s) => s.voices);
  const startClone = useCloneStore((s) => s.start);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const speakRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const [details, setDetails] = useState(false);

  const voices = useMemo(() => allVoices.filter((v) => !v.archived && (v.references?.length ?? 0) > 0), [allVoices]);

  useEffect(() => {
    if (!useSpeakStore.getState().ready) void init();
  }, [init]);

  // Keep the selection valid: a deleted/archived voice falls back to the first one.
  useEffect(() => {
    if (!ready || run) return;
    if (voiceId && voices.some((v) => v.id === voiceId)) return;
    const next = voices[0]?.id ?? null;
    if (next !== voiceId) void setVoice(next);
  }, [ready, run, voiceId, voices, setVoice]);

  // The cursor starts in the editor, at the end of the text (and returns there after a voice is created).
  const focusToken = useSpeakStore((s) => s.focusToken);
  useEffect(() => {
    if (!ready) return;
    const t = window.setTimeout(() => {
      const el = editorRef.current;
      if (!el || document.activeElement === el || document.querySelector('[role="dialog"]')) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    }, focusToken ? 60 : 0);
    return () => window.clearTimeout(t);
  }, [ready, focusToken]);

  // The Speak button turns into progress + Stop while running: keep keyboard focus on a control that exists
  // (Stop while running, Speak afterwards) instead of letting it fall back to the page.
  const runningNow = run != null;
  const wasRunning = useRef(false);
  useEffect(() => {
    const a = document.activeElement;
    const lost = !a || a === document.body || !document.contains(a);
    if (runningNow && !wasRunning.current && lost) stopRef.current?.focus();
    if (!runningNow && wasRunning.current && (lost || a === stopRef.current)) speakRef.current?.focus();
    wasRunning.current = runningNow;
  }, [runningNow]);

  // A new result is brought into view (on a small window it can be below the fold).
  const currentId = current?.id ?? null;
  const shownResult = useRef(currentId);
  useEffect(() => {
    if (currentId && currentId !== shownResult.current) resultRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    shownResult.current = currentId;
  }, [currentId]);

  // Leaving Speak drops a pending auto-play, so audio never starts by surprise when coming back later.
  useEffect(
    () => () => {
      const id = useSpeakStore.getState().playRequest;
      if (id) useSpeakStore.getState().consumePlay(id);
    },
    [],
  );

  // Save the text when the window is closed or hidden.
  useEffect(() => {
    const flush = () => void flushText();
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", flush);
      flush();
    };
  }, [flushText]);

  const doSpeak = useCallback(() => {
    void speak();
  }, [speak]);

  // Ctrl+Enter anywhere on this page (not inside a dialog); Esc stops a running Speak.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isInDialog(e.target) || document.querySelector('[role="dialog"]')) return;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        doSpeak();
      } else if (e.key === "Escape" && useSpeakStore.getState().run) {
        e.preventDefault();
        void cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doSpeak, cancel]);

  const onAction = async (action: FriendlyAction | undefined) => {
    dismissError();
    if (action === "install-model") {
      if (await ensureModels("speak")) void speak();
    } else if (action === "retry") void speak();
    else if (action === "system-check") navigate("setup");
    else if (action === "offline") navigate("settings", { section: "privacy" });
  };

  const onPlayStarted = useCallback(() => {
    const id = useSpeakStore.getState().playRequest;
    if (id) consumePlay(id);
  }, [consumePlay]);

  const running = run != null;
  const empty = !text.trim();
  const pct = run?.total && run.current != null ? Math.round((run.current / run.total) * 100) : null;

  if (!ready) {
    return (
      <div className="flex items-center justify-center h-full text-muted gap-3" role="status">
        <Spinner size={20} /> Opening…
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[960px] min-h-full flex flex-col gap-5 px-4 sm:px-8 pt-6 pb-5">
      {loadError && (
        <div role="alert" className="flex items-center gap-3 flex-wrap text-sm text-danger">
          <span>Your text and voices couldn't be loaded. {loadError.message}</span>
          <Button size="sm" onClick={() => void init()}>
            Try again
          </Button>
        </div>
      )}

      {/* Voice */}
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow" id="voice-label">
            Voice
          </span>
          <VoicePicker voices={voices} value={voiceId} onChange={(id) => void setVoice(id)} onClone={() => startClone()} onManage={() => navigate("voices")} disabled={running} />
        </div>
        <Button variant="soft" size="lg" icon={<Plus />} className="h-11" onClick={() => startClone()}>
          Clone Voice
        </Button>
      </div>

      {/* Editor */}
      <div className="panel flex-1 flex flex-col min-h-[240px] [@media(max-height:700px)]:min-h-[150px] focus-within:border-accent/50 focus-within:shadow-[0_0_0_3px_var(--color-accent-soft)] transition-[border-color,box-shadow]">
        <textarea
          ref={editorRef}
          aria-label="Text to speak"
          className="speak-editor"
          placeholder="Type what you want the voice to say…"
          spellCheck
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              e.stopPropagation();
              doSpeak();
            }
          }}
        />
        <div className="flex items-center justify-between gap-3 px-8 pb-3 text-[12.5px] text-muted min-h-[28px]">
          <span className="tabular-nums">{estimate(text)}</span>
          <span aria-live="polite">{saveState === "error" ? <span className="text-warn">Not saved yet — kept on this computer</span> : saveState === "saving" ? "Saving…" : saveState === "saved" && text ? "Saved" : ""}</span>
        </div>
      </div>

      {/* Speak */}
      <div className="flex flex-col items-center gap-2">
        {running ? (
          <div className="flex items-center gap-3 w-full max-w-[520px]">
            <div className="relative flex-1 h-14 rounded-[12px] bg-accent-soft text-accent overflow-hidden" role="status" aria-live="polite">
              {pct != null && <div className="absolute inset-y-0 left-0 bg-accent/15 transition-[width] duration-300" style={{ width: `${pct}%` }} aria-hidden />}
              <div className="relative h-full flex items-center justify-center gap-3 font-semibold text-[16px]">
                <Spinner size={18} label="" />
                {stepLabel(run)}
              </div>
            </div>
            <Button ref={stopRef} size="lg" variant="secondary" icon={<Square className="fill-current" />} className="h-14 px-5" onClick={() => void cancel()} disabled={run.cancelling}>
              Stop
            </Button>
          </div>
        ) : (
          <button
            ref={speakRef}
            type="button"
            onClick={doSpeak}
            disabled={empty}
            aria-label="Speak the text"
            title={empty ? "Type something to speak" : undefined}
            className={cx(
              "inline-flex items-center justify-center gap-3 h-14 w-full max-w-[520px] rounded-[12px] text-[18px] font-semibold tracking-[0.01em]",
              "bg-accent text-accent-text shadow-[0_6px_18px_-6px_var(--color-accent)] hover:bg-accent-hover active:translate-y-px transition-[background-color,transform]",
              "disabled:opacity-45 disabled:shadow-none disabled:cursor-not-allowed",
            )}
          >
            <AudioLines className="size-5" /> Speak
          </button>
        )}
        <p className="text-[12.5px] text-muted flex items-center gap-1.5">
          {running ? (
            run.step === "load" ? (
              "The first Speak after starting takes a little longer."
            ) : (
              <>
                <Kbd>Esc</Kbd> to stop
              </>
            )
          ) : (
            <>
              <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> to speak
            </>
          )}
        </p>
      </div>

      {/* Problems */}
      {needsVoice && (
        <div role="alert" className="flex items-center gap-4 flex-wrap rounded-[var(--radius-panel)] border border-border bg-panel px-5 py-4">
          <p className="flex-1 min-w-[240px] text-[15px]">{voices.length ? "Choose a voice first." : "First, clone a voice — it takes about a minute."}</p>
          {!voices.length && (
            <Button variant="primary" icon={<Plus />} onClick={() => startClone()}>
              Clone Voice
            </Button>
          )}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-[var(--radius-panel)] border border-danger/30 bg-danger-soft px-5 py-4 flex flex-col gap-2">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <p className="font-semibold">{error.title}</p>
              <p className="text-[14px] mt-0.5">{error.message}</p>
            </div>
            <button type="button" aria-label="Dismiss" onClick={dismissError} className="size-8 shrink-0 inline-flex items-center justify-center rounded-md text-muted hover:bg-hover">
              <X className="size-4" />
            </button>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {error.action === "install-model" && (
              <Button size="sm" variant="primary" onClick={() => void onAction("install-model")}>
                Install the voice model
              </Button>
            )}
            {error.action === "retry" && (
              <Button size="sm" variant="primary" onClick={() => void onAction("retry")}>
                Try again
              </Button>
            )}
            {error.action === "system-check" && (
              <Button size="sm" onClick={() => void onAction("system-check")}>
                Open system check
              </Button>
            )}
            {error.action === "offline" && (
              <Button size="sm" onClick={() => void onAction("offline")}>
                Open privacy settings
              </Button>
            )}
            <button type="button" className="text-[12.5px] text-muted hover:text-text underline-offset-2 hover:underline" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
              {details ? "Hide technical details" : "Technical details"}
            </button>
          </div>
          {details && <code className="block text-[12px] text-muted break-words whitespace-pre-wrap">{error.technical}</code>}
        </div>
      )}

      {/* Result */}
      {current && (
        <div ref={resultRef} className="flex flex-col gap-2 pt-1 scroll-mb-4">
          <h2 className="eyebrow">Generated speech</h2>
          <SpeechPlayer key={current.id} entry={current} playRequested={playRequest === current.id} onPlayStarted={onPlayStarted} />
        </div>
      )}
      <RecentList entries={history} currentId={current?.id ?? null} onPlay={play} onRemove={(e) => void forget(e)} onShowAll={() => void loadHistory()} />

      <footer className="mt-auto pt-2 flex items-center justify-center gap-1.5 text-[12px] text-muted">
        <Lock className="size-3.5" /> Runs locally on your computer.
      </footer>
    </div>
  );
}
