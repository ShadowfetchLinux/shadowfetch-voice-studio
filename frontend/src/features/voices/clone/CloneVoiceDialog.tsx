import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, FileAudio, Mic, Pause, Play, RotateCcw } from "lucide-react";
import { api, type RequestPromise } from "@/lib/api";
import type { Voice } from "@/lib/protocol";
import { WorkerError } from "@/lib/protocol";
import { describeIssue, friendlyError, logWorkerError, type FriendlyError } from "@/lib/friendlyErrors";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Checkbox } from "@/components/ui/Toggle";
import { Spinner } from "@/components/ui/Spinner";
import { usePlayer, type Selection } from "@/components/audio";
import { toast, useAppStore } from "@/store/appStore";
import { ensureModels, speakEngineId } from "@/store/modelSetup";
import { useVoicesStore } from "@/store/voicesStore";
import { useSpeakStore } from "@/features/speak/speakStore";
import { useCloneStore } from "../cloneStore";
import { useCreateStore } from "@/features/create/createStore";
import { defaultProcessing, toProcessingSteps, type ProcessingOptions } from "../processing";
import type { TranscriptState } from "../transcriptState";
import type { RecorderTake } from "../recorderMachine";
import { RecordStep } from "./RecordStep";
import { FileStep } from "./FileStep";
import { SampleEditor, type SampleEditResult } from "./SampleEditor";
import { LOW_CONFIDENCE, analyzeSample, nextStage, referenceLimits, type Analysis, type SampleSource } from "./cloneFlow";

type Stage =
  | { k: "choose" }
  | { k: "record" }
  | { k: "file"; notice?: string | null }
  | { k: "importing"; name: string }
  | { k: "analyzing"; src: SampleSource; what: "checking" | "words" }
  | { k: "problem"; src: SampleSource; analysis: Analysis }
  | { k: "edit"; src: SampleSource; analysis: Analysis; from: "problem" | "ready" | "auto"; back?: ReadyStage }
  | ReadyStage
  | { k: "failed"; error: FriendlyError; retry: (() => void) | null; back: "record" | "file" | "choose" };

type ReadyStage = { k: "ready"; src: SampleSource; analysis: Analysis; selection: Selection; transcript: TranscriptState; processing: ProcessingOptions; confidence: number | null };

/** Plays one range of a file (the chosen sample). */
function SamplePlayButton({ path, selection }: { path: string; selection: Selection }) {
  const player = usePlayer({ path, selection, restrictToSelection: true });
  return (
    <Button variant="soft" size="lg" icon={player.playing ? <Pause /> : <Play />} disabled={!player.ready && !player.playing} onClick={() => (player.playing ? player.pause() : void player.playSelection())}>
      {player.playing ? "Pause" : "Play Sample"}
    </Button>
  );
}

function ChoiceCard({ icon, title, text, onClick }: { icon: React.ReactNode; title: string; text: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-center justify-center gap-3 text-center rounded-[var(--radius-panel)] border border-border bg-panel p-7 min-h-[200px] transition-colors hover:border-accent hover:bg-accent-soft/40 focus-visible:border-accent"
    >
      <span className="inline-flex items-center justify-center size-14 rounded-full bg-accent-soft text-accent [&>svg]:size-7 group-hover:bg-accent group-hover:text-accent-text transition-colors">{icon}</span>
      <span className="text-[17px] font-semibold">{title}</span>
      <span className="text-[13px] text-muted max-w-[240px]">{text}</span>
    </button>
  );
}

/**
 * Clone Voice: Record Voice or Use Audio File → automatic checks, clean section, local transcription → name →
 * Create Voice. Problems are explained in plain words (Try Anyway / Choose Another / Edit Sample); Edit Sample is the
 * manual trim + words editor. Also used to add another recording to an existing voice.
 */
export function CloneVoiceDialog() {
  const open = useCloneStore((s) => s.open);
  const mode = useCloneStore((s) => s.mode);
  const origin = useCloneStore((s) => s.origin);
  const session = useCloneStore((s) => s.session);
  const close = useCloneStore((s) => s.close);
  const navigate = useAppStore((s) => s.navigate);
  const engines = useAppStore((s) => s.engines);
  const settings = useAppStore((s) => s.settings);
  const voices = useVoicesStore((s) => s.voices);
  const upsert = useVoicesStore((s) => s.upsert);

  const [stage, setStage] = useState<Stage>({ k: "choose" });
  const [name, setName] = useState("");
  const [rights, setRights] = useState(false);
  const [creating, setCreating] = useState(false);
  const [micOpen, setMicOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const inflight = useRef<RequestPromise<unknown> | null>(null);
  const alive = useRef(0);

  const target: Voice | null = mode.kind === "addRecording" ? (voices.find((v) => v.id === mode.voiceId) ?? null) : null;
  const engineId = speakEngineId(engines, settings, useSpeakStore.getState().engineOverride);
  const caps = engines.find((e) => e.id === engineId)?.capabilities ?? null;
  const limits = referenceLimits(caps?.reference);
  const language = target?.language ?? settings?.default_language ?? "en";

  // every open starts fresh
  useEffect(() => {
    if (!open) return;
    alive.current += 1;
    setStage({ k: "choose" });
    setName("");
    setRights(false);
    setCreating(false);
    setMicOpen(false);
    setConfirmClose(false);
  }, [open, session]);

  const cancelInflight = () => {
    const r = inflight.current;
    inflight.current = null;
    if (r) void r.cancel();
  };

  const doClose = () => {
    alive.current += 1;
    cancelInflight();
    setConfirmClose(false);
    close();
  };

  const requestClose = () => {
    if (creating) return;
    const hasWork = micOpen || stage.k === "ready" || stage.k === "edit" || stage.k === "problem" || stage.k === "analyzing" || stage.k === "importing";
    if (hasWork) setConfirmClose(true);
    else doClose();
  };

  const analyze = useCallback(
    async (src: SampleSource) => {
      const token = alive.current;
      setStage({ k: "analyzing", src, what: "checking" });
      if (!(await ensureModels("clone"))) {
        if (token === alive.current) setStage({ k: "failed", error: friendlyError(new WorkerError({ code: "MODEL_MISSING", message: "The speech recognition model is not installed." }), "clone"), retry: () => void analyze(src), back: src.origin === "recording" ? "record" : "file" });
        return;
      }
      try {
        const a = await analyzeSample(src, {
          engineId,
          asrModel: settings?.asr_model,
          asrDevice: settings?.asr_device,
          language,
          onRequest: (r) => (inflight.current = r),
          onStage: (what) => token === alive.current && setStage({ k: "analyzing", src, what }),
        });
        if (token !== alive.current) return;
        const next = nextStage(a);
        if (next === "ready") setStage({ k: "ready", src, analysis: a, selection: a.selection, transcript: a.transcript!, processing: defaultProcessing, confidence: a.confidence });
        else if (next === "problem") setStage({ k: "problem", src, analysis: a });
        else setStage({ k: "edit", src, analysis: a, from: "auto" });
      } catch (err) {
        if (token !== alive.current) return;
        const we = WorkerError.from(err);
        if (we.cancelled) return;
        logWorkerError("clone.analyze", we);
        // "No speech was detected" from the transcriber is a sample problem, not a failure
        if (we.code === "EMPTY_AUDIO") {
          setStage({ k: "failed", error: { ...friendlyError(we, "clone"), title: "No speech was found", message: describeIssue({ code: "NO_SPEECH" }) }, retry: null, back: src.origin === "recording" ? "record" : "file" });
        } else {
          setStage({ k: "failed", error: friendlyError(we, "clone"), retry: () => void analyze(src), back: src.origin === "recording" ? "record" : "file" });
        }
      }
    },
    [engineId, settings, language],
  );

  const onRecorded = useCallback(
    (t: RecorderTake) => {
      void analyze({ assetId: t.asset_id, path: t.working_path ?? t.path, origin: "recording", name: "Recording", durationS: t.duration_s });
    },
    [analyze],
  );

  const onFile = useCallback(
    async (path: string) => {
      const token = alive.current;
      const fname = path.split(/[\\/]/).pop() ?? "Audio file";
      setStage({ k: "importing", name: fname });
      try {
        const req = api.audio.import({ path, kind: "reference" });
        inflight.current = req;
        const r = await req;
        inflight.current = null;
        if (token !== alive.current) return;
        if (!name) setName(fname.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 40));
        void analyze({ assetId: r.asset_id, path: r.working_path || r.original_path, origin: "import", name: fname, durationS: r.probe.duration_s });
      } catch (err) {
        inflight.current = null;
        if (token !== alive.current) return;
        const we = WorkerError.from(err);
        if (we.cancelled) {
          setStage({ k: "file" });
          return;
        }
        logWorkerError("clone.import", we);
        setStage({ k: "file", notice: friendlyError(we, "import").message });
      }
    },
    [analyze, name],
  );

  const toReady = (src: SampleSource, analysis: Analysis, r: SampleEditResult) =>
    setStage({ k: "ready", src, analysis, selection: r.selection, transcript: r.transcript, processing: r.processing, confidence: r.transcript.reviewed ? null : r.confidence });

  const create = async () => {
    if (stage.k !== "ready" || creating) return;
    if (mode.kind === "new" && (!name.trim() || !rights)) return;
    if (mode.kind === "addRecording" && !target) return;
    const { src, selection, transcript, processing } = stage;
    setCreating(true);
    const common = {
      asset_id: src.assetId,
      trim: { start_s: selection.start, end_s: selection.end },
      transcript: transcript.text.trim(),
      transcript_source: transcript.source ?? "asr",
      // honest provenance: only words a person had on screen in Edit Sample and accepted count as reviewed
      transcript_confirmed: transcript.reviewed,
      asr_model: transcript.asrModel,
      processing: toProcessingSteps(processing),
      ...(engineId ? { engine_id: engineId } : {}),
    };
    try {
      let voice: Voice;
      if (mode.kind === "addRecording" && target) {
        await api.voices.addReference({ voice_id: target.id, select: true, label: null, ...common });
        voice = await api.voices.get(target.id);
        toast.success("Recording added", `${voice.name} now speaks with the new sample.`);
      } else {
        voice = await api.voices.create({ name: name.trim(), tags: [], language, rights_confirmed: true, ...common });
        toast.success("Voice created", `${voice.name} is ready — type something and press Speak.`);
      }
      upsert(voice);
      warmUp(voice);
      doClose();
      if (origin === "editor") {
        // stay in the project editor; it lists the new voice and uses it for the open project
        const cs = useCreateStore.getState();
        await cs.loadVoices();
        if (cs.projectId) await cs.setVoice(voice.id, null);
      } else {
        await useSpeakStore.getState().setVoice(voice.id);
        navigate("speak");
        useSpeakStore.getState().requestEditorFocus();
      }
    } catch (err) {
      logWorkerError("clone.create", err);
      const f = friendlyError(err, "clone");
      toast.error(f.title, f.message);
    } finally {
      setCreating(false);
    }
  };

  /** Prepare the voice for the engine in the background so the first Speak starts sooner (best effort). */
  const warmUp = (voice: Voice) => {
    const refId = voice.selected_reference_id;
    const model = useAppStore.getState().models.find((m) => m.engine_id === engineId && m.kind === "tts");
    if (!engineId || !refId || model?.state !== "installed") return;
    void api.engine.prepareReference({ engine_id: engineId, reference_id: refId }).catch((e) => logWorkerError("clone.warmup", e));
  };

  const title = useMemo(() => {
    switch (stage.k) {
      case "record":
        return "Record Your Voice";
      case "file":
      case "importing":
        return "Use an Audio File";
      case "analyzing":
        return "Preparing your sample";
      case "problem":
        return stage.analysis.blocking.length ? "This sample can't be used" : "This sample may not clone well";
      case "edit":
        return "Edit Sample";
      case "ready":
        return "Voice sample ready";
      case "failed":
        return stage.error.title;
      default:
        return mode.kind === "addRecording" ? `Add a recording${target ? ` to ${target.name}` : ""}` : "Clone a Voice";
    }
  }, [stage, mode.kind, target]);

  const back = stage.k === "record" || stage.k === "file" ? () => setStage({ k: "choose" }) : null;
  const again = (src: SampleSource) => setStage(src.origin === "recording" ? { k: "record" } : { k: "file" });

  return (
    <>
      <Dialog open={open} onClose={requestClose} locked={creating} title={title} size={stage.k === "edit" ? "lg" : "md"}>
        <div className="flex flex-col gap-5 pb-2">
          {back && (
            <button type="button" onClick={back} disabled={micOpen} className="self-start -mt-1 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-text disabled:opacity-50">
              <ArrowLeft className="size-4" /> Back
            </button>
          )}

          {stage.k === "choose" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <ChoiceCard icon={<Mic />} title="Record Voice" text="Use your microphone." onClick={() => setStage({ k: "record" })} />
              <ChoiceCard icon={<FileAudio />} title="Use Audio File" text="WAV, MP3, FLAC and other common audio formats." onClick={() => setStage({ k: "file" })} />
            </div>
          )}

          {stage.k === "record" && <RecordStep onRecorded={onRecorded} onActiveChange={setMicOpen} />}

          {stage.k === "file" && <FileStep onFile={(p) => void onFile(p)} notice={stage.notice ?? null} />}

          {(stage.k === "importing" || stage.k === "analyzing") && (
            <div className="flex flex-col items-center gap-4 py-10" role="status" aria-live="polite">
              <Spinner size={28} />
              <p className="text-[15px]">{stage.k === "importing" ? `Opening ${stage.name}…` : stage.what === "words" ? "Listening to the words…" : "Finding the clearest part…"}</p>
              <Button variant="ghost" onClick={() => {
                alive.current += 1;
                cancelInflight();
                setStage(stage.k === "analyzing" ? (stage.src.origin === "recording" ? { k: "record" } : { k: "file" }) : { k: "file" });
              }}>
                Cancel
              </Button>
            </div>
          )}

          {stage.k === "problem" && (
            <div className="flex flex-col gap-4">
              <ul className="flex flex-col gap-2">
                {[...stage.analysis.blocking, ...stage.analysis.warnings.filter((w) => w.code !== "SHORT")].map((i) => (
                  <li key={i.code} className="text-[15px]">
                    {describeIssue(i)}
                  </li>
                ))}
              </ul>
              <p className="text-[14px] text-muted">{stage.analysis.blocking.length ? "Try another recording." : "Try another recording for better cloning, or use this one anyway."}</p>
              <div className="flex items-center gap-2 flex-wrap justify-end pt-2">
                {!stage.analysis.blocking.length && (
                  <Button variant="ghost" onClick={() => setStage({ k: "edit", src: stage.src, analysis: stage.analysis, from: "problem" })}>
                    Edit Sample
                  </Button>
                )}
                <Button variant={stage.analysis.blocking.length ? "primary" : "secondary"} icon={<RotateCcw />} onClick={() => again(stage.src)}>
                  {stage.src.origin === "recording" ? "Record Again" : "Choose Another File"}
                </Button>
                {!stage.analysis.blocking.length && (
                  <Button
                    variant="primary"
                    onClick={() => {
                      const a = stage.analysis;
                      if (a.transcript?.text && a.suggestion.reliable) setStage({ k: "ready", src: stage.src, analysis: a, selection: a.selection, transcript: a.transcript, processing: defaultProcessing, confidence: a.confidence });
                      else setStage({ k: "edit", src: stage.src, analysis: a, from: "problem" });
                    }}
                  >
                    Try Anyway
                  </Button>
                )}
              </div>
            </div>
          )}

          {stage.k === "edit" && (
            <SampleEditor
              key={`${stage.src.assetId}`}
              path={stage.src.path}
              assetId={stage.src.assetId}
              initialSelection={stage.analysis.selection}
              initialTranscript={stage.analysis.transcript}
              initialProcessing={defaultProcessing}
              reference={limits}
              language={language}
              intro={stage.from === "auto" ? `Choose the part to clone from — about ${limits.recommended_seconds[0]}–${limits.recommended_seconds[1]} seconds of clear speech, starting and ending between words.` : undefined}
              submitLabel="Use This Sample"
              onCancel={() => (stage.back ? setStage(stage.back) : stage.from === "problem" ? setStage({ k: "problem", src: stage.src, analysis: stage.analysis }) : again(stage.src))}
              onSubmit={(r) => toReady(stage.src, stage.analysis, r)}
            />
          )}

          {stage.k === "ready" && (
            <form
              className="flex flex-col gap-5"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <div className="flex items-center gap-4 flex-wrap">
                <SamplePlayButton path={stage.src.path} selection={stage.selection} />
                <span className="text-[14px] text-muted flex items-center gap-1.5">
                  <Check className="size-4 text-success" /> {(stage.selection.end - stage.selection.start).toFixed(0)} seconds of clear speech
                </span>
              </div>
              {!stage.transcript.reviewed && ((stage.confidence != null && stage.confidence < LOW_CONFIDENCE) || stage.analysis.warnings.some((w) => w.code === "SHORT")) && (
                <p className="text-[13px] text-warn">
                  {stage.confidence != null && stage.confidence < LOW_CONFIDENCE ? "Some words may have been misheard — check them under Edit Sample." : describeIssue({ code: "SHORT" })}
                </p>
              )}
              {mode.kind === "new" ? (
                <>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-medium">Voice Name</span>
                    <input className="field-input control text-[16px]" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bob" maxLength={60} autoFocus onFocus={(e) => e.currentTarget.select()} aria-label="Voice Name" />
                  </label>
                  <Checkbox label="This is my voice, or I have permission to clone it." checked={rights} onChange={setRights} />
                </>
              ) : (
                <p className="text-[14px]">{target ? `${target.name} will speak with this new sample.` : "This voice no longer exists."}</p>
              )}
              <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
                <button type="button" className="text-[13px] font-medium text-accent hover:underline" onClick={() => setStage({ k: "edit", src: stage.src, analysis: { ...stage.analysis, selection: stage.selection, transcript: stage.transcript }, from: "ready", back: stage })}>
                  Edit Sample
                </button>
                <Button type="submit" variant="primary" size="lg" loading={creating} disabled={mode.kind === "new" ? !name.trim() || !rights : !target}>
                  {mode.kind === "new" ? "Create Voice" : "Add Recording"}
                </Button>
              </div>
            </form>
          )}

          {stage.k === "failed" && (
            <div className="flex flex-col gap-4">
              <p className="text-[15px]">{stage.error.message}</p>
              <div className="flex items-center gap-2 justify-end flex-wrap">
                <Button variant="ghost" onClick={() => setStage({ k: stage.back } as Stage)}>
                  {stage.back === "record" ? "Record Again" : stage.back === "file" ? "Choose Another File" : "Back"}
                </Button>
                {stage.retry && (
                  <Button variant="primary" onClick={stage.retry}>
                    Try Again
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </Dialog>
      <ConfirmDialog open={confirmClose} onCancel={() => setConfirmClose(false)} onConfirm={doClose} title="Stop cloning this voice?" confirmLabel="Discard" cancelLabel="Keep going" destructive>
        <p>{micOpen ? "The recording in progress will be discarded." : "Your sample won't be turned into a voice."}</p>
      </ConfirmDialog>
    </>
  );
}
