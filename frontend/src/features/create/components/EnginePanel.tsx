import { useEffect, useState, type ReactNode } from "react";
import { Settings2 } from "lucide-react";
import type { Capabilities, EngineInfo } from "@/lib/protocol";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Collapsible, StatusPill } from "@/components/ui/Feedback";
import { Switch } from "@/components/ui/Toggle";
import { useAppStore } from "@/store/appStore";
import { useCreateStore } from "../createStore";
import { clampMaxChars, controlValues } from "../planMath";
import { CapabilityControls } from "./CapabilityControls";
import { PronunciationEditor } from "./PronunciationEditor";
import { TagPalette } from "./TagPalette";

/** Numeric input that commits on blur/Enter (avoids persisting every keystroke). */
function CommitNumber({ label, value, min, max, suffix, hint, onCommit, disabled }: { label: string; value: number; min: number; max: number; suffix?: string; hint?: ReactNode; onCommit: (v: number) => void; disabled?: boolean }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const n = Number(text);
  const invalid = text !== "" && (!Number.isFinite(n) || n < min || n > max);
  const commit = () => {
    if (text === "" || invalid || n === value) {
      setText(String(value));
      return;
    }
    onCommit(n);
  };
  return (
    <Input
      label={label}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={text}
      suffix={suffix}
      hint={hint}
      error={invalid ? `Enter a value between ${min} and ${max}` : undefined}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div>
      <h3 className="text-[13px] font-medium">{children}</h3>
      {hint && <p className="text-[12.5px] text-muted mt-0.5">{hint}</p>}
    </div>
  );
}

export interface EnginePanelProps {
  engines: EngineInfo[];
  caps: Capabilities | null;
}

/** Engine, language, engine-declared controls/tags/post-processing, seed and segmentation options. */
export function EnginePanel({ engines, caps }: EnginePanelProps) {
  const engineId = useCreateStore((s) => s.engineId);
  const setEngine = useCreateStore((s) => s.setEngine);
  const language = useCreateStore((s) => s.language);
  const setLanguage = useCreateStore((s) => s.setLanguage);
  const controls = useCreateStore((s) => (s.engineId ? s.controls[s.engineId] : undefined));
  const setControl = useCreateStore((s) => s.setControl);
  const post = useCreateStore((s) => (s.engineId ? s.postProcessing[s.engineId] : undefined));
  const setPostProcessing = useCreateStore((s) => s.setPostProcessing);
  const seed = useCreateStore((s) => s.seed);
  const setSeed = useCreateStore((s) => s.setSeed);
  const plan = useCreateStore((s) => s.plan);
  const setPlanOption = useCreateStore((s) => s.setPlanOption);
  const segmentationOpen = useCreateStore((s) => s.segmentationOpen);
  const setSegmentationOpen = useCreateStore((s) => s.setSegmentationOpen);
  const busy = useCreateStore((s) => s.job != null);
  const hasProject = useCreateStore((s) => s.projectId != null);
  const engineStates = useAppStore((s) => s.engineStates);
  const navigate = useAppStore((s) => s.navigate);

  const installed = engines.filter((e) => e.installed);
  const engine = engines.find((e) => e.id === engineId) ?? null;
  const modelMissing = engine != null && engine.model_state !== "installed";
  const liveState = engineId ? (engineStates[engineId]?.state ?? engine?.state ?? "unloaded") : "unloaded";
  const disabled = !hasProject || busy;
  const controlVals = controlValues(caps?.controls ?? [], controls);
  const postVals = controlValues(caps?.post_processing ?? [], post);

  return (
    <div className="flex flex-col gap-5">
      {installed.length === 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">No engine environment is installed.</p>
          <Button size="sm" icon={<Settings2 />} onClick={() => navigate("settings", { section: "engines" })} className="self-start">
            Open Settings
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Select
            label="Engine"
            options={installed.map((e) => ({ value: e.id, label: e.name }))}
            placeholder="Choose an engine…"
            value={engineId && installed.some((e) => e.id === engineId) ? engineId : ""}
            disabled={disabled}
            onChange={(e) => e.target.value && setEngine(e.target.value)}
            hint={caps ? `${caps.name} ${caps.version} · ${caps.output_sample_rate} Hz output · ≤ ${caps.max_chars_per_request} chars per request${caps.watermark ? ` · watermark: ${caps.watermark}` : ""}` : undefined}
          />
          <div className="flex items-center gap-2 flex-wrap">
            <StatusPill tone={liveState === "loaded" ? "success" : liveState === "loading" ? "warn" : liveState === "error" ? "danger" : "neutral"} dot pulse={liveState === "loading"} size="sm">
              engine {liveState}
            </StatusPill>
            {modelMissing && (
              <StatusPill tone="warn" size="sm">
                model {engine?.model_state ?? "missing"}
              </StatusPill>
            )}
            {modelMissing && (
              <button type="button" className="text-[12.5px] font-medium text-accent hover:underline" onClick={() => navigate("settings", { section: "engines" })}>
                Install the model in Settings
              </button>
            )}
          </div>
        </div>
      )}

      {caps && caps.languages.length > 0 && (
        <Select label="Language" options={caps.languages.map((l) => ({ value: l.code, label: l.label }))} value={language} disabled={disabled} onChange={(e) => setLanguage(e.target.value)} />
      )}

      {caps && caps.controls.length > 0 && (
        <div className="flex flex-col gap-3">
          <SectionTitle hint="Only settings this engine declared are shown.">Generation settings</SectionTitle>
          <CapabilityControls specs={caps.controls} values={controlVals} onChange={(id, v) => engineId && setControl(engineId, id, v)} disabled={disabled} advancedTitle="Advanced generation settings" />
        </div>
      )}

      {caps && <TagPalette tags={caps.tags} disabled={disabled} />}

      {caps && caps.post_processing.length > 0 && (
        <div className="flex flex-col gap-3">
          <SectionTitle hint="App-side processing, not an engine parameter. Values are saved with the project; this worker build exposes no method that applies them yet.">Post-processing</SectionTitle>
          <CapabilityControls specs={caps.post_processing} values={postVals} onChange={(id, v) => engineId && setPostProcessing(engineId, id, v)} disabled={disabled} advancedTitle="Advanced post-processing" />
        </div>
      )}

      {caps?.supports_seed && (
        <Input
          label="Seed (optional)"
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          placeholder="random"
          value={seed ?? ""}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (v === "") setSeed(null);
            else {
              const n = parseInt(v, 10);
              if (Number.isFinite(n) && n >= 0) setSeed(n);
            }
          }}
          hint="Segment k uses seed + k. The same seed does not guarantee identical output across environments (GPU, driver or library versions)."
        />
      )}

      <Collapsible title="Segmentation" description="Pauses, segment size and text normalisation used by Plan" open={segmentationOpen} onOpenChange={setSegmentationOpen}>
        <div className="flex flex-col gap-4 pt-3">
          <div className="grid grid-cols-2 gap-3">
            <CommitNumber label="Sentence pause" value={plan.sentence_pause_ms} min={0} max={10000} suffix="ms" disabled={disabled} onCommit={(v) => setPlanOption("sentence_pause_ms", v)} />
            <CommitNumber label="Paragraph pause" value={plan.paragraph_pause_ms} min={0} max={10000} suffix="ms" disabled={disabled} onCommit={(v) => setPlanOption("paragraph_pause_ms", v)} />
          </div>
          <CommitNumber
            label="Max characters per segment"
            value={clampMaxChars(plan.max_chars, caps)}
            min={20}
            max={caps?.max_chars_per_request ?? 5000}
            suffix="chars"
            disabled={disabled}
            onCommit={(v) => setPlanOption("max_chars", v)}
            hint={caps ? `Clamped to the engine limit of ${caps.max_chars_per_request}.` : "Clamped to the engine limit once an engine is selected."}
          />
          <PronunciationEditor rules={plan.pronunciation} onChange={(rules) => setPlanOption("pronunciation", rules)} disabled={disabled} />
          <Switch label="Spell out numbers" description="Write digits as words before sending them to the engine (each change is listed on the segment)." checked={plan.spell_numbers} onChange={(v) => setPlanOption("spell_numbers", v)} disabled={disabled} />
        </div>
      </Collapsible>
    </div>
  );
}
