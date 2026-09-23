import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Voice } from "@/lib/protocol";
import { friendlyError, logWorkerError } from "@/lib/friendlyErrors";
import { Dialog } from "@/components/ui/Dialog";
import { toast, useAppStore } from "@/store/appStore";
import { speakEngineId } from "@/store/modelSetup";
import { sampleAudioPath, useVoicesStore } from "@/store/voicesStore";
import { useSpeakStore } from "@/features/speak/speakStore";
import { SampleEditor, type SampleEditResult } from "./clone/SampleEditor";
import { referenceLimits } from "./clone/cloneFlow";
import { processingFromSteps, toProcessingSteps } from "./processing";

export interface EditSampleDialogProps {
  voice: Voice | null;
  onClose: () => void;
}

/**
 * Edit Sample for a saved voice: re-trim the part it is cloned from, fix the words, clean it up. Saving updates the
 * voice's recording (the original audio is untouched); derived engine files are rebuilt on the next Speak.
 * A voice with several recordings can switch which one it speaks with here.
 */
export function EditSampleDialog({ voice, onClose }: EditSampleDialogProps) {
  const engines = useAppStore((s) => s.engines);
  const settings = useAppStore((s) => s.settings);
  const upsert = useVoicesStore((s) => s.upsert);
  const [refId, setRefId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRefId(voice?.selected_reference_id ?? voice?.references?.[voice.references.length - 1]?.id ?? null);
  }, [voice]);

  const refs = voice?.references ?? [];
  const ref = refs.find((r) => r.id === refId) ?? null;
  const path = sampleAudioPath(ref);
  const engineId = speakEngineId(engines, settings, useSpeakStore.getState().engineOverride);
  const limits = referenceLimits(engines.find((e) => e.id === engineId)?.capabilities?.reference);

  const save = async (r: SampleEditResult) => {
    if (!voice || !ref) return;
    setSaving(true);
    try {
      await api.voices.updateReference({
        reference_id: ref.id,
        patch: {
          trim: { start_s: r.selection.start, end_s: r.selection.end },
          transcript: r.transcript.text.trim(),
          transcript_source: r.transcript.source ?? "edited",
          transcript_confirmed: r.transcript.reviewed,
          asr_model: r.transcript.asrModel,
          processing: toProcessingSteps(r.processing),
        },
      });
      if (ref.id !== voice.selected_reference_id) await api.voices.selectReference({ voice_id: voice.id, reference_id: ref.id });
      upsert(await api.voices.get(voice.id));
      toast.success("Sample updated", `${voice.name} will use it the next time you press Speak.`);
      onClose();
    } catch (err) {
      logWorkerError("voice.edit_sample", err);
      const f = friendlyError(err, "clone");
      toast.error(f.title, f.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!voice} onClose={onClose} locked={saving} title={voice ? `Edit Sample — ${voice.name}` : "Edit Sample"} size="lg">
      {voice && refs.length > 1 && (
        <label className="flex items-center gap-3 mb-4 text-[13px]">
          <span className="text-muted">Recording</span>
          <select className="field-input control w-auto min-w-[220px]" value={refId ?? ""} onChange={(e) => setRefId(e.target.value)} disabled={saving}>
            {refs.map((r, i) => (
              <option key={r.id} value={r.id}>
                {r.label || `Recording ${i + 1}`}
                {r.id === voice.selected_reference_id ? " (in use)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {voice && ref && path ? (
        <SampleEditor
          key={ref.id}
          path={path}
          assetId={ref.asset_id}
          initialSelection={{ start: ref.start_s, end: ref.end_s }}
          initialTranscript={{ text: ref.transcript, source: ref.transcript_source ?? "edited", asrModel: ref.asr_model ?? null, language: voice.language }}
          initialProcessing={processingFromSteps(ref.processing)}
          reference={limits}
          language={voice.language}
          submitLabel={ref.id === voice.selected_reference_id ? "Save Sample" : "Save and Use This Recording"}
          busy={saving}
          onCancel={onClose}
          onSubmit={(r) => void save(r)}
        />
      ) : voice ? (
        <p className="text-sm pb-4">The original recording for this voice is no longer on this computer, so its sample can't be edited. Add a new recording instead.</p>
      ) : null}
    </Dialog>
  );
}
