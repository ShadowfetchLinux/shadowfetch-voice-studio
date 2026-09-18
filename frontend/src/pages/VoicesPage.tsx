import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { Voice } from "@/lib/protocol";
import { WorkerError } from "@/lib/protocol";
import { Spinner } from "@/components/ui/Spinner";
import { useAppStore } from "@/store/appStore";
import { NewVoiceWizard, VoiceDetail, VoiceList, type SourceMode, type WizardMode } from "@/features/voices";

type RightPane = { kind: "new" } | { kind: "voice"; id: string } | { kind: "addReference"; id: string };

/** Voices: saved voices on the left, the "New voice" / "Add reference" workflow or the voice's references on the right. */
export default function VoicesPage() {
  const params = useAppStore((s) => s.params);
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [pane, setPane] = useState<RightPane>(params.voiceId ? { kind: "voice", id: params.voiceId } : { kind: "new" });
  const initialSource: SourceMode | null = params.action === "record" ? "record" : params.action === "import" ? "import" : null;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.voices.list();
      setVoices(r.voices);
      setError(null);
    } catch (err) {
      setError(WorkerError.from(err).message);
      setVoices((v) => v ?? []);
    } finally {
      setLoading(false);
    }
    api.library
      .tags()
      .then((r) => setTags(r.tags.map((t) => (typeof t === "string" ? t : t.name))))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (params.voiceId) setPane({ kind: "voice", id: params.voiceId });
    else if (params.action === "record" || params.action === "import") setPane({ kind: "new" });
  }, [params]);

  const selectedId = pane.kind === "new" ? null : pane.id;
  const selectedVoice = useMemo(() => voices?.find((v) => v.id === selectedId) ?? null, [voices, selectedId]);
  const wizardMode: WizardMode | null = pane.kind === "new" ? { kind: "new" } : pane.kind === "addReference" && selectedVoice ? { kind: "addReference", voice: selectedVoice } : null;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(320px,420px)_minmax(0,1fr)] gap-6 items-start">
      <VoiceList
        voices={voices}
        loading={loading}
        error={error}
        selectedId={selectedId}
        onSelect={(id) => setPane(id ? { kind: "voice", id } : { kind: "new" })}
        onNewVoice={() => setPane({ kind: "new" })}
        onAddReference={(v) => setPane({ kind: "addReference", id: v.id })}
        onChanged={() => void reload()}
        tagSuggestions={tags}
      />
      {wizardMode ? (
        <NewVoiceWizard
          key={wizardMode.kind === "new" ? "new" : `add-${wizardMode.voice.id}`}
          mode={wizardMode}
          initialSource={initialSource}
          tagSuggestions={tags}
          onSaved={(v) => {
            void reload();
            if (wizardMode.kind === "addReference") setPane({ kind: "voice", id: v.id });
          }}
          onCancel={wizardMode.kind === "addReference" ? () => setPane({ kind: "voice", id: wizardMode.voice.id }) : undefined}
        />
      ) : selectedVoice ? (
        <VoiceDetail voice={selectedVoice} onAddReference={() => setPane({ kind: "addReference", id: selectedVoice.id })} onChanged={() => void reload()} />
      ) : voices == null ? (
        <div className="panel flex items-center gap-2 p-5 text-muted text-sm">
          <Spinner /> Loading voice…
        </div>
      ) : (
        <NewVoiceWizard key="new-fallback" mode={{ kind: "new" }} initialSource={initialSource} tagSuggestions={tags} onSaved={() => void reload()} />
      )}
    </div>
  );
}
