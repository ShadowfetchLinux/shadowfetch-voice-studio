import { useCallback, useEffect, useReducer, useState } from "react";
import { ArrowLeft, ArrowRight, Check, RotateCcw, Sparkles } from "lucide-react";
import type { Voice } from "@/lib/protocol";
import { cx } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { Selection } from "@/components/audio";
import { useAppStore } from "@/store/appStore";
import { SourceStep } from "./SourceStep";
import { ReviewStep } from "./ReviewStep";
import { TranscriptStep } from "./TranscriptStep";
import { SaveStep } from "./SaveStep";
import { useCapabilities } from "./useCapabilities";
import { validateSelection } from "./trimValidation";
import { canUseTranscript, initialTranscriptState, selectionKey, transcriptReducer } from "./transcriptState";
import { defaultProcessing, type ProcessingOptions } from "./processing";
import { STEP_TITLES, type SourceClip, type SourceMode, type WizardMode, type WizardStep } from "./wizardTypes";

export interface NewVoiceWizardProps {
  mode: WizardMode;
  /** Preselect the source (from the Home page actions). */
  initialSource?: SourceMode | null;
  tagSuggestions?: string[];
  onSaved: (voice: Voice, referenceId: string | null) => void;
  /** Leave the workflow (only offered in addReference mode). */
  onCancel?: () => void;
}

const STEPS: WizardStep[] = [1, 2, 3, 4];

/** Four-step "New voice" / "Add reference" workflow with real gating between the steps. */
export function NewVoiceWizard({ mode, initialSource = null, tagSuggestions = [], onSaved, onCancel }: NewVoiceWizardProps) {
  const settings = useAppStore((s) => s.settings);
  const navigate = useAppStore((s) => s.navigate);
  const [step, setStep] = useState<WizardStep>(1);
  const [sourceMode, setSourceMode] = useState<SourceMode | null>(initialSource);
  const [source, setSource] = useState<SourceClip | null>(null);
  const [selection, setSelectionState] = useState<Selection | null>(null);
  const [processing, setProcessing] = useState<ProcessingOptions>(defaultProcessing);
  const [transcript, dispatchTranscript] = useReducer(transcriptReducer, initialTranscriptState);
  const [engineId, setEngineId] = useState(settings?.default_engine ?? "");
  const [language, setLanguage] = useState(mode.kind === "addReference" ? mode.voice.language : (settings?.default_language ?? "en"));
  const [done, setDone] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const { caps, error: capsError } = useCapabilities(engineId || null);

  useEffect(() => {
    if (!engineId && settings?.default_engine) setEngineId(settings.default_engine);
  }, [settings, engineId]);

  const key = selectionKey(source?.path ?? null, selection);
  const setSelection = useCallback(
    (sel: Selection | null) => {
      setSelectionState(sel);
      dispatchTranscript({ type: "selectionChanged", key: selectionKey(source?.path ?? null, sel) });
    },
    [source],
  );

  const chooseSource = (clip: SourceClip) => {
    if (source?.asset_id === clip.asset_id) return;
    setSource(clip);
    setSelectionState(null);
    dispatchTranscript({ type: "reset" });
  };

  const verdict = validateSelection(selection, caps?.reference ?? null);
  const stepOk: Record<WizardStep, boolean> = {
    1: source != null,
    2: source != null && selection != null && verdict.level !== "error",
    3: source != null && selection != null && canUseTranscript(transcript, key),
    4: done,
  };
  const canGo = (target: WizardStep) => !(recordingActive && step === 1 && target !== 1) && STEPS.filter((s) => s < target).every((s) => stepOk[s]);

  const reset = () => {
    setStep(1);
    setSource(null);
    setSelectionState(null);
    setProcessing(defaultProcessing);
    dispatchTranscript({ type: "reset" });
    setDone(false);
    setRecordingActive(false);
  };

  const title = mode.kind === "new" ? "New voice" : `Add a reference to "${mode.voice.name}"`;

  return (
    <Card
      id="new-voice-wizard"
      tabIndex={-1}
      title={title}
      description={mode.kind === "new" ? "Record or import a short sample, pick the best few seconds, check the words, then save." : "Same steps as a new voice. The new recording becomes another option for this voice."}
      actions={
        <>
          {done && mode.kind === "new" && (
            <Button size="sm" variant="primary" icon={<Sparkles />} onClick={() => navigate("create", { action: "new" })}>
              Create speech
            </Button>
          )}
          {done && (
            <Button size="sm" icon={<RotateCcw />} onClick={reset}>
              Start another
            </Button>
          )}
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Back to voice
            </Button>
          )}
        </>
      }
    >
      <ol className="flex items-center gap-2 mb-5 flex-wrap" aria-label="Steps">
        {STEPS.map((s) => {
          const reachable = canGo(s);
          const complete = stepOk[s] && s !== step;
          return (
            <li key={s} className="flex items-center gap-2">
              <button
                type="button"
                aria-current={s === step ? "step" : undefined}
                disabled={!reachable}
                onClick={() => setStep(s)}
                className={cx(
                  "inline-flex items-center gap-2 h-9 pl-1.5 pr-3 rounded-full text-[13px] font-medium border transition-colors disabled:opacity-50",
                  s === step ? "border-accent bg-accent-soft text-accent" : complete ? "border-success/40 bg-success-soft text-success" : "border-border text-muted",
                )}
              >
                <span className={cx("inline-flex items-center justify-center size-6 rounded-full text-[12px]", s === step ? "bg-accent text-white" : complete ? "bg-success text-white" : "bg-black/6 text-muted")}>{complete ? <Check className="size-3.5" /> : s}</span>
                {STEP_TITLES[s]}
              </button>
              {s < 4 && <span className="w-4 h-px bg-border-strong" aria-hidden />}
            </li>
          );
        })}
      </ol>

      {step === 1 && <SourceStep mode={sourceMode} onModeChange={setSourceMode} source={source} onSource={chooseSource} recordingActive={recordingActive} onRecordingActiveChange={setRecordingActive} />}
      {step === 2 && source && <ReviewStep source={source} caps={caps} capsError={capsError} selection={selection} onSelectionChange={setSelection} processing={processing} onProcessingChange={setProcessing} />}
      {step === 3 && source && <TranscriptStep source={source} selection={selection} transcript={transcript} dispatch={dispatchTranscript} language={language} />}
      {step === 4 && source && selection && (
        <SaveStep
          mode={mode}
          source={source}
          selection={selection}
          transcript={transcript}
          processing={processing}
          engineId={engineId}
          onEngineChange={setEngineId}
          caps={caps}
          language={language}
          onLanguageChange={setLanguage}
          tagSuggestions={tagSuggestions}
          onSaved={(v, r) => {
            setDone(true);
            onSaved(v, r);
          }}
        />
      )}

      <div className="flex items-center justify-between gap-3 mt-6 pt-4 border-t border-border">
        <Button variant="ghost" icon={<ArrowLeft />} disabled={step === 1 || done} onClick={() => setStep((s) => (s > 1 ? ((s - 1) as WizardStep) : s))}>
          Back
        </Button>
        <span className="text-[12.5px] text-muted">
          {step === 1 && recordingActive ? "Stop or discard the recording before continuing." : step === 1 && !source ? "Choose Record or Import a file, then pick the take to continue." : null}
          {step === 2 && verdict.level === "error" && verdict.message}
          {step === 3 && !stepOk[3] && (transcript.text.trim() ? "Confirm the transcript to continue." : "Transcribe or type the transcript to continue.")}
        </span>
        <Button variant="primary" iconRight={<ArrowRight />} disabled={step === 4 || !stepOk[step] || (step === 1 && recordingActive)} onClick={() => setStep((s) => (s < 4 ? ((s + 1) as WizardStep) : s))}>
          {step === 4 ? "Done" : "Next"}
        </Button>
      </div>
    </Card>
  );
}
