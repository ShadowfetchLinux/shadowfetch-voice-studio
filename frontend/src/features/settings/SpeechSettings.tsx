/**
 * Settings for the Speak screen.
 * - `SpeechBasics`: the two choices a normal user might care about (auto-play, Save Audio format).
 * - `SpeakAdvanced`: engine, language, the engine's own declared controls, seed, pauses, segment length, pronunciation —
 *   stored on the Speak scratch project, so they apply to every Speak without appearing on the Speak screen.
 * - `SaveAudioAdvanced`: WAV bit depth, MP3 bitrate, named loudness target, AI-generated metadata.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import type { LoudnessTarget, LoudnessTargetId, PronunciationRule } from "@/lib/protocol";
import { logWorkerError } from "@/lib/friendlyErrors";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Checkbox, Switch } from "@/components/ui/Toggle";
import { useAppStore } from "@/store/appStore";
import { speakEngineId } from "@/store/modelSetup";
import { useVoicesStore } from "@/store/voicesStore";
import { useSpeakStore, type SpeakOverrides } from "@/features/speak/speakStore";
import { CapabilityControls } from "@/features/create/components/CapabilityControls";
import { PronunciationEditor } from "@/features/create/components/PronunciationEditor";
import { clampMaxChars, planOptionsFrom } from "@/features/create/planMath";
import type { Project } from "@/lib/protocol";
import { FORMATS } from "@/features/speak/saveAudio";

export function SpeechBasics() {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  return (
    <div className="flex flex-col gap-5">
      <Switch
        label="Play speech automatically"
        description="Start playing as soon as the speech is ready."
        checked={settings?.speak_autoplay ?? true}
        onChange={(v) => void saveSettings({ speak_autoplay: v }, { silent: true })}
        disabled={!settings}
      />
      <Select
        label="Save Audio as"
        value={settings?.export_default_format ?? "wav"}
        options={FORMATS.map((f) => ({ value: f.id, label: `${f.label} — ${f.hint}` }))}
        onChange={(e) => void saveSettings({ export_default_format: e.target.value }, { silent: true })}
        disabled={!settings}
      />
    </div>
  );
}

/** Persist a patch into the Speak scratch project's settings, then refresh the store's copy. */
async function patchSpeakProject(projectId: string, settings: Record<string, unknown>) {
  try {
    await api.projects.update({ id: projectId, patch: { settings } });
  } catch (err) {
    logWorkerError("speak.settings", err);
  }
  await useSpeakStore.getState().refreshProjectSettings();
}

export function SpeakAdvanced() {
  const projectId = useSpeakStore((s) => s.projectId);
  const ps = useSpeakStore((s) => s.projectSettings);
  const running = useSpeakStore((s) => s.run != null);
  const voiceId = useSpeakStore((s) => s.voiceId);
  const engines = useAppStore((s) => s.engines);
  const settings = useAppStore((s) => s.settings);
  const voice = useVoicesStore((s) => s.voices.find((v) => v.id === voiceId) ?? null);

  useEffect(() => {
    if (!useSpeakStore.getState().ready) void useSpeakStore.getState().init();
  }, []);

  const overrides = (ps.speak as SpeakOverrides | undefined) ?? {};
  const engineId = speakEngineId(engines, settings, overrides.engine_id ?? null);
  const engine = engines.find((e) => e.id === engineId) ?? null;
  const caps = engine?.capabilities ?? null;
  const stored = ((ps.controls as Record<string, Record<string, unknown>> | undefined) ?? {})[engineId ?? ""] ?? {};
  const plan = useMemo(
    () =>
      planOptionsFrom({ settings: ps } as unknown as Project, {
        max_chars: settings?.max_chars_per_segment ?? 400,
        paragraph_pause_ms: settings?.paragraph_pause_ms ?? 600,
        sentence_pause_ms: settings?.sentence_pause_ms ?? 250,
        pronunciation: [],
        spell_numbers: false,
      }),
    [ps, settings],
  );

  // Sliders move continuously: keep a local copy and write after a short pause.
  const [controls, setControls] = useState<Record<string, unknown>>(stored);
  const [rules, setRules] = useState<PronunciationRule[]>(plan.pronunciation);
  const [seedText, setSeedText] = useState(typeof ps.seed === "number" ? String(ps.seed) : "");
  useEffect(() => setSeedText(typeof ps.seed === "number" ? String(ps.seed) : ""), [ps.seed]);
  useEffect(() => setControls(stored), [JSON.stringify(stored)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setRules(plan.pronunciation), [JSON.stringify(plan.pronunciation)]); // eslint-disable-line react-hooks/exhaustive-deps
  const timer = useRef<number | null>(null);
  const later = (fn: () => void) => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(fn, 500);
  };

  if (!projectId) return <p className="text-sm text-muted">Loading…</p>;
  const setOverride = (patch: SpeakOverrides) => void patchSpeakProject(projectId, { speak: { ...overrides, ...patch } });
  const setPlan = (patch: Record<string, unknown>) => void patchSpeakProject(projectId, { plan: patch });
  const installed = engines.filter((e) => e.installed);
  const langs = caps?.languages ?? [];

  return (
    <div className="flex flex-col gap-6">
      {running && <p className="text-[13px] text-warn">Speech is being generated; changes apply to the next Speak.</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Select
          label="Engine"
          value={overrides.engine_id ?? ""}
          options={[{ value: "", label: `Automatic${engine ? ` (${engine.name})` : ""}` }, ...installed.map((e) => ({ value: e.id, label: e.name }))]}
          onChange={(e) => setOverride({ engine_id: e.target.value || null })}
          hint="Automatic uses the default engine. Only installed engines are listed."
        />
        <Select
          label="Language"
          value={overrides.language ?? ""}
          options={[{ value: "", label: `Same as the voice${voice ? ` (${langs.find((l) => l.code === voice.language)?.label ?? voice.language})` : ""}` }, ...langs.map((l) => ({ value: l.code, label: l.label }))]}
          onChange={(e) => setOverride({ language: e.target.value || null })}
          hint="Languages the selected engine declares."
        />
      </div>

      {caps && caps.controls.length > 0 ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h3>{caps.name} settings</h3>
            <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => engineId && void patchSpeakProject(projectId, { controls: { [engineId]: {} } })}>
              Reset to defaults
            </Button>
          </div>
          <p className="text-[12.5px] text-muted -mt-2">Only settings this engine actually supports are shown.</p>
          <CapabilityControls
            specs={caps.controls}
            values={controls}
            advancedTitle="More engine settings"
            onChange={(id, v) => {
              const next = { ...controls, [id]: v };
              setControls(next);
              if (engineId) later(() => void patchSpeakProject(projectId, { controls: { [engineId]: next } }));
            }}
          />
        </div>
      ) : (
        <p className="text-[13px] text-muted">{engine ? `${engine.name} has no adjustable settings.` : "No engine is installed yet."}</p>
      )}

      {caps?.supports_seed && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
          <Input
            label="Seed"
            type="number"
            placeholder="Random"
            value={seedText}
            hint="Leave empty for a different reading each time. A fixed seed repeats a reading on this computer."
            onChange={(e) => {
              setSeedText(e.target.value);
              const v = e.target.value.trim();
              const n = v === "" ? null : Math.trunc(Number(v));
              if (v === "" || Number.isFinite(n)) later(() => void patchSpeakProject(projectId, { seed: n }));
            }}
          />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Input label="Pause between sentences" type="number" min={0} max={3000} step={10} suffix="ms" defaultValue={plan.sentence_pause_ms} onBlur={(e) => setPlan({ sentence_pause_ms: Math.max(0, Math.min(3000, Number(e.target.value) || 0)) })} />
        <Input label="Pause between paragraphs" type="number" min={0} max={5000} step={50} suffix="ms" defaultValue={plan.paragraph_pause_ms} onBlur={(e) => setPlan({ paragraph_pause_ms: Math.max(0, Math.min(5000, Number(e.target.value) || 0)) })} />
        <Input
          label="Longest piece per generation"
          type="number"
          min={40}
          max={caps?.max_chars_per_request ?? 2000}
          suffix="chars"
          defaultValue={clampMaxChars(plan.max_chars, caps)}
          hint={caps ? `Long text is split at sentence ends; ${caps.name} allows up to ${caps.max_chars_per_request}.` : undefined}
          onBlur={(e) => setPlan({ max_chars: clampMaxChars(Number(e.target.value) || 400, caps) })}
        />
      </div>
      <Checkbox label="Spell out numbers" description={'Reads "42" as "forty-two".'} checked={plan.spell_numbers} onChange={(v) => setPlan({ spell_numbers: v })} />
      <PronunciationEditor
        rules={rules}
        onChange={(r) => {
          setRules(r);
          later(() => setPlan({ pronunciation: r.filter((x) => x.from.trim()) }));
        }}
      />
    </div>
  );
}

export function SaveAudioAdvanced() {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const [targets, setTargets] = useState<LoudnessTarget[]>([]);
  useEffect(() => {
    api.export
      .loudnessTargets()
      .then((r) => setTargets(r.targets))
      .catch(() => setTargets([]));
  }, []);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Select
        label="WAV quality"
        value={String(settings?.export_wav_bit_depth ?? 24)}
        options={[
          { value: "16", label: "16-bit" },
          { value: "24", label: "24-bit (recommended)" },
          { value: "32", label: "32-bit float" },
        ]}
        onChange={(e) => void saveSettings({ export_wav_bit_depth: Number(e.target.value) }, { silent: true })}
        disabled={!settings}
      />
      <Select
        label="MP3 quality"
        value={String(settings?.export_mp3_bitrate_kbps ?? 192)}
        options={[128, 192, 256, 320].map((b) => ({ value: String(b), label: `${b} kbps${b === 192 ? " (recommended)" : ""}` }))}
        onChange={(e) => void saveSettings({ export_mp3_bitrate_kbps: Number(e.target.value) }, { silent: true })}
        disabled={!settings}
      />
      <Select
        label="Loudness"
        value={settings?.export_loudness_target ?? ""}
        options={[{ value: "", label: "As generated (no change)" }, ...targets.map((t) => ({ value: t.id, label: t.label }))]}
        onChange={(e) => void saveSettings({ export_loudness_target: (e.target.value || null) as LoudnessTargetId | null }, { silent: true })}
        hint="Normalises saved files to a named target, measured after saving."
        disabled={!settings}
      />
      <div className="md:pt-6">
        <Checkbox
          label="Mark files as AI-generated"
          description="Adds a note to the saved file's metadata."
          checked={settings?.export_ai_metadata ?? true}
          onChange={(v) => void saveSettings({ export_ai_metadata: v }, { silent: true })}
          disabled={!settings}
        />
      </div>
    </div>
  );
}
