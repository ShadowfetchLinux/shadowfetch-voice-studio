import { useRef, useState } from "react";
import { AlertTriangle, Captions, X } from "lucide-react";
import { api, type RequestPromise } from "@/lib/api";
import type { Progress, TranscribeResult } from "@/lib/protocol";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";
import { Checkbox } from "@/components/ui/Toggle";
import { ProgressBar } from "@/components/ui/Feedback";
import type { Selection } from "@/components/audio";
import { handleError, toast, useAppStore } from "@/store/appStore";
import { isTranscriptStale, selectionKey, type TranscriptAction, type TranscriptState } from "./transcriptState";
import type { SourceClip } from "./wizardTypes";

export interface TranscriptStepProps {
  source: SourceClip;
  selection: Selection | null;
  transcript: TranscriptState;
  dispatch: (a: TranscriptAction) => void;
  /** Language hint for ASR (engine language code, e.g. "en"). */
  language: string;
}

/** Step 3: transcribe the selection with the worker's ASR model, then review and confirm the text. */
export function TranscriptStep({ source, selection, transcript, dispatch, language }: TranscriptStepProps) {
  const settings = useAppStore((s) => s.settings);
  const models = useAppStore((s) => s.models);
  const navigate = useAppStore((s) => s.navigate);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const reqRef = useRef<RequestPromise<TranscribeResult> | null>(null);

  const key = selectionKey(source.path, selection);
  const stale = isTranscriptStale(transcript, key);
  const modelId = settings?.asr_model ?? null;
  const device = settings?.asr_device ?? "cpu";
  const modelRow = models.find((m) => m.id === modelId) ?? null;
  const modelInstalled = modelRow ? modelRow.state === "installed" : null;

  const transcribe = async () => {
    if (!selection) return;
    setBusy(true);
    setProgress(null);
    const req = api.transcribe.run({ path: source.path, start_s: selection.start, end_s: selection.end, model_id: modelId ?? undefined, language: language || undefined, device }, { onProgress: setProgress });
    reqRef.current = req;
    try {
      const r = await req;
      dispatch({ type: "transcribed", text: r.text.trim(), key, model: r.model_id, language: r.language });
      toast.success("Transcribed", `${r.model_id} on ${r.device.toUpperCase()} · ${r.elapsed_s.toFixed(1)} s${r.language ? ` · language ${r.language}${r.language_probability ? ` (${Math.round(r.language_probability * 100)}%)` : ""}` : ""}`);
    } catch (err) {
      const we = handleError(err, "Transcription failed");
      if (we.code === "MODEL_MISSING") toast.info("Transcription model not installed", "Download it under Settings → Engines & models.", { action: { label: "Open Settings", onClick: () => navigate("settings", { section: "models" }) } });
    } finally {
      reqRef.current = null;
      setBusy(false);
      setProgress(null);
    }
  };

  const seconds = progress?.detail && typeof progress.detail.seconds_total === "number" ? { done: Number(progress.detail.seconds_done ?? 0), total: Number(progress.detail.seconds_total) } : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="primary" icon={<Captions />} loading={busy} disabled={!selection} onClick={() => void transcribe()}>
          {transcript.text ? "Re-transcribe selection" : "Transcribe selection"}
        </Button>
        {busy && (
          <Button variant="ghost" icon={<X />} onClick={() => void reqRef.current?.cancel()}>
            Cancel
          </Button>
        )}
        <span className="text-[12.5px] text-muted">
          {modelId ? (
            <>
              Model <strong className="text-text">{modelId}</strong> on {device.toUpperCase()}
              {modelInstalled === false && <span className="text-warn"> — not installed</span>}
              {modelInstalled === false && (
                <button type="button" className="ml-1 text-accent font-medium hover:underline" onClick={() => navigate("settings", { section: "models" })}>
                  Open Settings
                </button>
              )}
            </>
          ) : (
            "Transcription model: from Settings"
          )}
        </span>
      </div>
      {busy && (
        <ProgressBar
          label={progress?.stage === "queued" ? "Waiting for the GPU (another job is running)" : (progress?.message ?? "Starting…")}
          current={seconds ? Math.round(seconds.done) : null}
          total={seconds ? Math.round(seconds.total) : null}
          caption={seconds ? `${Math.round(seconds.done)} of ${Math.round(seconds.total)} s` : undefined}
        />
      )}

      {stale && (
        <div role="alert" className="flex items-start gap-3 rounded-[var(--radius-control)] border border-warn/40 bg-warn-soft px-4 py-3 text-sm">
          <AlertTriangle className="size-4 text-warn shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Selection changed — re-transcribe or confirm the transcript still matches.</p>
            <p className="text-[12.5px] text-muted mt-0.5">The text below was made for a different range of the audio. The engine needs the exact words spoken in the selected part.</p>
          </div>
          <Button size="sm" onClick={() => dispatch({ type: "confirmMatches", key })}>
            It still matches
          </Button>
        </div>
      )}

      <Textarea
        label="Transcript of the selection"
        rows={6}
        value={transcript.text}
        onChange={(e) => dispatch({ type: "edit", text: e.target.value, key })}
        placeholder="Exactly what is said in the selected range — punctuation helps."
        hint={transcript.source === "asr" ? `Transcribed by ${transcript.asrModel ?? "ASR"}${transcript.language ? ` (${transcript.language})` : ""}. Fix any mistakes before confirming.` : transcript.source === "edited" ? "Typed / edited by you." : "Run transcription or type the words yourself."}
        textareaClassName="text-[15px] leading-relaxed"
      />

      <Checkbox
        label="I reviewed this transcript and it matches the selected audio word for word"
        description="Required. The reference transcript conditions the engine; mismatches degrade the cloned voice."
        checked={transcript.reviewed}
        disabled={!transcript.text.trim() || stale}
        onChange={(v) => dispatch({ type: "review", reviewed: v })}
      />
    </div>
  );
}
