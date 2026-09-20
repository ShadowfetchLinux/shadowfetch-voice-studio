import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Voice } from "@/lib/protocol";
import { WorkerError } from "@/lib/protocol";
import { Spinner } from "@/components/ui/Spinner";
import { useAppStore, type RouteParams } from "@/store/appStore";
import { NewVoiceWizard, VoiceDetail, VoiceList, type SourceMode, type WizardMode } from "@/features/voices";

type RightPane = { kind: "new" } | { kind: "voice"; id: string } | { kind: "addReference"; id: string };

function isVoiceAction(action: RouteParams["action"]): action is "record" | "import" | "new" {
  return action === "record" || action === "import" || action === "new";
}

function paneFromParams(params: RouteParams): RightPane {
  if (params.voiceId && isVoiceAction(params.action)) return { kind: "addReference", id: params.voiceId };
  if (params.voiceId) return { kind: "voice", id: params.voiceId };
  return { kind: "new" };
}

/** Voices: saved voices on the left, the "New voice" / "Add reference" workflow or the voice's recordings on the right. */
export default function VoicesPage() {
  const params = useAppStore((s) => s.params);
  const navigate = useAppStore((s) => s.navigate);
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [pane, setPane] = useState<RightPane>(() => paneFromParams(params));
  const [wizardEpoch, setWizardEpoch] = useState(0);
  const paramsRef = useRef(params);
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

  // Route params are the source of truth for starting the create-voice flow. A new params object
  // (even with the same action) remounts the wizard so "New voice" is never a no-op.
  useEffect(() => {
    const prev = paramsRef.current;
    paramsRef.current = params;
    const next = paneFromParams(params);
    if (params.voiceId && !isVoiceAction(params.action)) {
      setPane(next);
      return;
    }
    if (isVoiceAction(params.action)) {
      setPane(next);
      if (prev !== params) setWizardEpoch((e) => e + 1);
    }
  }, [params]);

  const startNewVoice = useCallback(
    (source?: SourceMode) => {
      navigate("voices", { action: source ?? "new" });
    },
    [navigate],
  );

  useEffect(() => {
    if (pane.kind !== "new" && pane.kind !== "addReference") return;
    const el = document.getElementById("new-voice-wizard");
    if (!el) return;
    el.scrollIntoView?.({ block: "nearest" });
    const focus = el.querySelector<HTMLElement>("button[role='radio']");
    focus?.focus({ preventScroll: true });
  }, [wizardEpoch, pane.kind]);

  const selectedId = pane.kind === "new" ? null : pane.id;
  const selectedVoice = useMemo(() => voices?.find((v) => v.id === selectedId) ?? null, [voices, selectedId]);
  const wizardMode: WizardMode | null = pane.kind === "new" ? { kind: "new" } : pane.kind === "addReference" && selectedVoice ? { kind: "addReference", voice: selectedVoice } : null;
  const wizardKey = wizardMode?.kind === "new" ? `new-${wizardEpoch}-${params.action ?? "pick"}` : wizardMode ? `add-${wizardMode.voice.id}-${wizardEpoch}` : "idle";

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(320px,420px)_minmax(0,1fr)] gap-6 items-start">
      <VoiceList
        voices={voices}
        loading={loading}
        error={error}
        selectedId={selectedId}
        onSelect={(id) => setPane(id ? { kind: "voice", id } : { kind: "new" })}
        onNewVoice={startNewVoice}
        onAddReference={(v) => setPane({ kind: "addReference", id: v.id })}
        onChanged={() => void reload()}
        tagSuggestions={tags}
      />
      {wizardMode ? (
        <NewVoiceWizard
          key={wizardKey}
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
        <NewVoiceWizard key={`new-fallback-${wizardEpoch}`} mode={{ kind: "new" }} initialSource={initialSource} tagSuggestions={tags} onSaved={() => void reload()} />
      )}
    </div>
  );
}
