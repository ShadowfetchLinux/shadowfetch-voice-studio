import { useEffect, useState } from "react";
import { CheckCircle2, Save, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import type { AddReferenceParams, Capabilities, Progress, Reference, Voice, VoiceCreateParams } from "@/lib/protocol";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Checkbox } from "@/components/ui/Toggle";
import { Collapsible, ProgressBar } from "@/components/ui/Feedback";
import type { Selection } from "@/components/audio";
import { handleError, toast, useAppStore } from "@/store/appStore";
import { TagChipsInput } from "./TagChipsInput";
import { toProcessingSteps, type ProcessingOptions } from "./processing";
import type { TranscriptState } from "./transcriptState";
import type { SourceClip, WizardMode } from "./wizardTypes";

export interface SaveStepProps {
  mode: WizardMode;
  source: SourceClip;
  selection: Selection;
  transcript: TranscriptState;
  processing: ProcessingOptions;
  engineId: string;
  onEngineChange: (id: string) => void;
  caps: Capabilities | null;
  language: string;
  onLanguageChange: (code: string) => void;
  tagSuggestions: string[];
  onSaved: (voice: Voice, referenceId: string | null) => void;
}

interface SavedInfo {
  voice: Voice;
  referenceId: string | null;
  warnings: string[];
}

/** Step 4: name/tags/language/rights → voices.create (or voices.add_reference), optional engine.prepare_reference. */
export function SaveStep({ mode, source, selection, transcript, processing, engineId, onEngineChange, caps, language, onLanguageChange, tagSuggestions, onSaved }: SaveStepProps) {
  const engines = useAppStore((s) => s.engines);
  const [name, setName] = useState("");
  const [tags, setTags] = useState<string[]>(mode.kind === "addReference" ? mode.voice.tags : []);
  const [rights, setRights] = useState(false);
  const [prepareNow, setPrepareNow] = useState(false);
  const [setActive, setSetActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SavedInfo | null>(null);
  const [prepare, setPrepare] = useState<{ progress: Progress | null; done: boolean; error: string | null } | null>(null);

  const languages = caps?.languages ?? [];
  useEffect(() => {
    if (languages.length && !languages.some((l) => l.code === language)) onLanguageChange(languages.find((l) => l.code === "en")?.code ?? languages[0]!.code);
  }, [languages, language, onLanguageChange]);

  const canSave = !saving && !saved && transcript.text.trim().length > 0 && transcript.reviewed && (mode.kind === "addReference" || (name.trim().length > 0 && rights));

  const save = async () => {
    setSaving(true);
    const steps = toProcessingSteps(processing);
    const common = { asset_id: source.asset_id, trim: { start_s: selection.start, end_s: selection.end }, transcript: transcript.text.trim() };
    // The worker also stores how the transcript came to be; these fields are not in the PROTOCOL types yet.
    const extra = { transcript_source: transcript.source ?? "edited", transcript_confirmed: true, asr_model: transcript.asrModel };
    try {
      let voice: Voice;
      let referenceId: string | null;
      let warnings: string[] = [];
      if (mode.kind === "new") {
        const params: VoiceCreateParams & typeof extra = { name: name.trim(), tags, language, rights_confirmed: true, engine_id: engineId, processing: steps, ...common, ...extra };
        const r = (await api.voices.create(params)) as Voice & { warnings?: string[] };
        voice = r;
        referenceId = r.selected_reference_id ?? r.references?.[0]?.id ?? null;
        warnings = r.warnings ?? [];
        toast.success("Voice saved", `${voice.name} · reference ${(selection.end - selection.start).toFixed(1)} s`);
      } else {
        // `engine_id` makes the worker check the trim against that engine's reference limits, as voices.create does.
        const params: AddReferenceParams & typeof extra & { select: boolean; label: string | null; processing: unknown[] } = { voice_id: mode.voice.id, select: setActive, label: name.trim() || null, processing: steps, ...(engineId ? { engine_id: engineId } : {}), ...common, ...extra };
        const ref = (await api.voices.addReference(params)) as Reference;
        voice = await api.voices.get(mode.voice.id);
        referenceId = ref.id;
        toast.success("Reference added", `${mode.voice.name} now has ${voice.references?.length ?? "another"} reference${(voice.references?.length ?? 2) === 1 ? "" : "s"}`);
      }
      setSaved({ voice, referenceId, warnings });
      onSaved(voice, referenceId);
      if (prepareNow && referenceId) await runPrepare(referenceId);
    } catch (err) {
      handleError(err, mode.kind === "new" ? "Could not save the voice" : "Could not add the reference");
    } finally {
      setSaving(false);
    }
  };

  const runPrepare = async (referenceId: string) => {
    setPrepare({ progress: null, done: false, error: null });
    try {
      const r = await api.engine.prepareReference({ engine_id: engineId, reference_id: referenceId }, { onProgress: (p) => setPrepare((s) => ({ ...(s ?? { done: false, error: null }), progress: p })) });
      setPrepare({ progress: null, done: true, error: null });
      toast.success("Reference prepared", `${r.engine_id} · model ${r.model_revision.slice(0, 12)}`);
    } catch (err) {
      const we = handleError(err, "Could not prepare the reference");
      setPrepare({ progress: null, done: false, error: `${we.message} (${we.code})` });
    }
  };

  const engineOptions = engines.map((e) => ({ value: e.id, label: `${e.name}${e.installed ? "" : " (environment not installed)"}` }));
  if (engineId && !engines.some((e) => e.id === engineId)) engineOptions.push({ value: engineId, label: engineId });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {mode.kind === "new" ? (
          <Input label="Voice name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My narration voice" required disabled={!!saved} autoFocus />
        ) : (
          <Input label="Reference label (optional)" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Calm narration take 2" disabled={!!saved} />
        )}
        {languages.length > 0 ? (
          <Select label="Language" value={language} options={languages.map((l) => ({ value: l.code, label: l.label }))} onChange={(e) => onLanguageChange(e.target.value)} disabled={!!saved} hint="Languages declared by the selected engine." />
        ) : (
          <Input label="Language code" value={language} onChange={(e) => onLanguageChange(e.target.value.trim().toLowerCase())} placeholder="en" disabled={!!saved} hint="The engine did not report its languages; enter a code." />
        )}
      </div>
      {mode.kind === "new" && <TagChipsInput value={tags} onChange={setTags} suggestions={tagSuggestions} disabled={!!saved} hint="Optional. Used for filtering." />}

      {mode.kind === "new" ? (
        <Checkbox label="This is my own voice or I have permission to use it" description="Required. Do not clone someone else's voice without their permission." checked={rights} onChange={setRights} disabled={!!saved} />
      ) : (
        <>
          <Checkbox label="Use this recording as the active one" description="Create uses the voice's active recording." checked={setActive} onChange={setSetActive} disabled={!!saved} />
          <p className="text-[12.5px] text-muted">Rights were confirmed when the voice "{mode.voice.name}" was created.</p>
        </>
      )}

      <Collapsible title="Advanced" description="Engine check and optional GPU prepare — you can skip this." className="shadow-none">
        <div className="flex flex-col gap-3 pt-1">
          <Select label="Engine to check against" value={engineId} options={engineOptions} onChange={(e) => onEngineChange(e.target.value)} disabled={!!saved} hint="Used to validate the trim length. Generation can still use another engine later." />
          <Checkbox label="Prepare for the engine now" description="Optional. Loads the engine so the first generate is a bit faster. You can also do this later from Create." checked={prepareNow} onChange={setPrepareNow} disabled={!!saved} />
        </div>
      </Collapsible>

      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="primary" size="lg" icon={<Save />} loading={saving} disabled={!canSave} onClick={() => void save()}>
          {mode.kind === "new" ? "Save voice" : "Add reference"}
        </Button>
        {!saved && !transcript.reviewed && <span className="text-[12.5px] text-muted">Confirm the transcript in step 3 first.</span>}
      </div>

      {saved && (
        <div className="rounded-[var(--radius-control)] border border-success/40 bg-success-soft px-4 py-3 text-sm flex flex-col gap-2">
          <p className="flex items-center gap-2 font-medium text-success">
            <CheckCircle2 className="size-4" /> {mode.kind === "new" ? `Saved "${saved.voice.name}".` : `Reference added to "${saved.voice.name}".`}
          </p>
          {saved.warnings.map((w) => (
            <p key={w} className="text-[12.5px] text-warn">
              {w}
            </p>
          ))}
          {prepare && (
            <div className="flex flex-col gap-2">
              {!prepare.done && !prepare.error && (
                <ProgressBar label={prepare.progress?.stage === "queued" ? "Waiting for the GPU (another job is running)" : (prepare.progress?.message ?? "Preparing reference…")} current={prepare.progress?.current} total={prepare.progress?.total} />
              )}
              {prepare.done && (
                <p className="text-[12.5px] text-success flex items-center gap-1.5">
                  <Sparkles className="size-4" /> Prepared for {engineId}.
                </p>
              )}
              {prepare.error && (
                <p role="alert" className="text-[12.5px] text-danger">
                  {prepare.error}
                </p>
              )}
            </div>
          )}
          {!prepare && saved.referenceId && (
            <Button size="sm" icon={<Sparkles />} onClick={() => void runPrepare(saved.referenceId!)}>
              Prepare for {engineId} now
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
