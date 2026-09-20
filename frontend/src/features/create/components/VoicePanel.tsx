import { Mic } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { formatDuration } from "@/lib/format";
import { newVoiceParams, useAppStore } from "@/store/appStore";
import { useCreateStore } from "../createStore";

const EXCERPT = 160;

/** Voice + reference clip selector with the selected reference's duration and transcript excerpt. */
export function VoicePanel() {
  const voices = useCreateStore((s) => s.voices);
  const voiceId = useCreateStore((s) => s.voiceId);
  const referenceId = useCreateStore((s) => s.referenceId);
  const setVoice = useCreateStore((s) => s.setVoice);
  const busy = useCreateStore((s) => s.job != null);
  const hasProject = useCreateStore((s) => s.projectId != null);
  const navigate = useAppStore((s) => s.navigate);

  const voice = voices.find((v) => v.id === voiceId) ?? null;
  const references = voice?.references ?? [];
  const reference = references.find((r) => r.id === (referenceId ?? voice?.selected_reference_id)) ?? references[0] ?? null;

  if (voices.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted">No voices yet. Record or import a short sample first.</p>
        <Button size="sm" variant="primary" icon={<Mic />} onClick={() => navigate("voices", newVoiceParams())} className="self-start">
          New voice
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Select
        label="Voice"
            options={voices.filter((v) => !v.archived || v.id === voiceId).map((v) => ({ value: v.id, label: `${v.name}${v.references?.length ? ` (${v.references.length} recording${v.references.length === 1 ? "" : "s"})` : " (no recording)"}` }))}
        placeholder="Choose a voice…"
        value={voiceId ?? ""}
        disabled={!hasProject || busy}
        onChange={(e) => {
          const v = voices.find((x) => x.id === e.target.value);
          if (v) void setVoice(v.id, v.selected_reference_id ?? v.references?.[0]?.id ?? null);
        }}
      />
      {voice && references.length > 0 && (
        <Select
          label="Recording"
          options={references.map((r, i) => ({ value: r.id, label: `${r.label || `Reference ${i + 1}`} · ${formatDuration(r.end_s - r.start_s)}` }))}
          value={reference?.id ?? ""}
          disabled={!hasProject || busy}
          onChange={(e) => void setVoice(voice.id, e.target.value)}
        />
      )}
      {voice && references.length === 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-[12.5px] text-warn">This voice has no recording yet.</p>
          <Button size="sm" icon={<Mic />} onClick={() => navigate("voices", { ...newVoiceParams(), voiceId: voice.id })} className="self-start">
            Add recording
          </Button>
        </div>
      )}
      {reference && (
        <div className="rounded-md bg-panel-alt border border-border px-3 py-2 text-[12.5px] flex flex-col gap-1">
          <p className="tabular-nums">
            <span className="text-muted">Sample length:</span> {formatDuration(reference.end_s - reference.start_s)}
            {reference.transcript_confirmed === false && <span className="text-warn ml-2">words not confirmed</span>}
          </p>
          <p>
            <span className="text-muted">Words in the sample:</span>{" "}
            {reference.transcript ? (
              <span className="italic">
                “{reference.transcript.slice(0, EXCERPT).trim()}
                {reference.transcript.length > EXCERPT ? "…" : ""}”
              </span>
            ) : (
              <span className="text-warn">empty — add the words spoken in the sample before generating</span>
            )}
          </p>
          <p className="text-muted">These are the words spoken in the sample, not your script. They do not need to match.</p>
        </div>
      )}
    </div>
  );
}
