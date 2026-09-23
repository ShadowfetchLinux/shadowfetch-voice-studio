import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Archive, Cpu, Eraser, FolderOpen, Loader2, Power, PowerOff, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { EngineInfo, StorageUsage } from "@/lib/protocol";
import { cx, formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Input, Select } from "@/components/ui/Field";
import { Collapsible, StatusPill, type PillTone } from "@/components/ui/Feedback";
import { Switch } from "@/components/ui/Toggle";
import { AudioDevices } from "@/components/settings/AudioDevices";
import { SaveAudioAdvanced, SpeakAdvanced, SpeechBasics } from "@/features/settings/SpeechSettings";
import { ModelRow } from "@/components/model-manager/ModelRow";
import { handleError, toast, useAppStore } from "@/store/appStore";
import { useModelOps } from "@/store/modelOps";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface NumberSettingProps {
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  hint?: ReactNode;
  onCommit: (v: number) => void;
  disabled?: boolean;
}

/** Numeric input that commits on blur / Enter (avoids saving every keystroke). */
function NumberSetting({ label, value, min, max, step = 1, suffix, hint, onCommit, disabled }: NumberSettingProps) {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => setText(value == null ? "" : String(value)), [value]);
  const invalid = text !== "" && (!Number.isFinite(Number(text)) || Number(text) < min || Number(text) > max);
  const commit = () => {
    const v = Number(text);
    if (text === "" || invalid || v === value) {
      setText(value == null ? "" : String(value));
      return;
    }
    onCommit(v);
  };
  return (
    <Input
      label={label}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={step}
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

const ENGINE_TONE: Record<EngineInfo["state"], PillTone> = { loaded: "success", loading: "warn", unloaded: "neutral", error: "danger" };

// ---------------------------------------------------------------------------
// Engines & models
// ---------------------------------------------------------------------------

function EngineCard({ engine }: { engine: EngineInfo }) {
  const live = useAppStore((s) => s.engineStates[engine.id]);
  const model = useAppStore((s) => s.models.find((m) => m.engine_id === engine.id) ?? null);
  const busy = useModelOps((s) => s.busy[engine.id]);
  const ops = useModelOps();
  const state = live?.state ?? engine.state;
  const message = live?.message ?? engine.message;
  const vram = live?.vram_bytes ?? engine.vram_bytes;
  const modelInstalled = (model?.state ?? engine.model_state) === "installed";
  const probe = engine.env_probe;

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3>{engine.name}</h3>
            <StatusPill tone={engine.installed ? "success" : "warn"} size="sm">
              {engine.installed ? "environment installed" : "environment missing"}
            </StatusPill>
            <StatusPill tone={ENGINE_TONE[state]} size="sm" dot pulse={state === "loading"}>
              {state}
              {state === "loaded" && vram ? ` · ${formatBytes(vram)} VRAM` : ""}
            </StatusPill>
            {engine.optional && (
              <StatusPill tone="neutral" size="sm">
                optional
              </StatusPill>
            )}
          </div>
          {engine.description && <p className="text-[12.5px] text-muted mt-1">{engine.description}</p>}
          {probe && (probe.torch || probe.error || probe.torch_error) && (
            <p className="text-[12px] text-muted mt-0.5 font-mono">
              {probe.python ? `python ${probe.python}` : null}
              {probe.torch ? ` · torch ${probe.torch}` : null}
              {probe.cuda_device ? ` · ${probe.cuda_device}` : probe.cuda_available === false ? " · CUDA unavailable" : null}
              {probe.error || probe.torch_error ? ` · ${probe.error ?? probe.torch_error}` : null}
            </p>
          )}
          {message && state !== "loaded" && <p className={cx("text-[12.5px] mt-1", state === "error" ? "text-danger" : "text-muted")}>{message}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {state === "loaded" || state === "loading" ? (
            <Button icon={<PowerOff />} loading={busy === "unload"} onClick={() => void ops.unloadEngine(engine.id)} disabled={state === "loading" && busy === "load"}>
              Unload
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<Power />}
              loading={busy === "load"}
              disabled={!engine.installed || !modelInstalled}
              title={!engine.installed ? "Install the Python environment first" : !modelInstalled ? "Install the model first" : "Start the engine process and load weights"}
              onClick={() => void ops.loadEngine(engine.id)}
            >
              Load
            </Button>
          )}
        </div>
      </div>
      {model ? (
        <ModelRow model={model} className="mt-2 border-t border-border" />
      ) : (
        <p className="text-[12.5px] text-muted mt-2">No model registered for this engine.</p>
      )}
    </div>
  );
}

function EnginesSection() {
  const engines = useAppStore((s) => s.engines);
  const models = useAppStore((s) => s.models);
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const loadEngines = useAppStore((s) => s.loadEngines);
  const loadModels = useAppStore((s) => s.loadModels);
  const asrModels = models.filter((m) => m.kind === "asr");

  return (
    <Card
      id="engines"
      title="Models & engines"
      description="One engine is loaded at a time; unloading ends its process and returns VRAM."
      actions={
        <Button size="sm" variant="ghost" icon={<RefreshCw />} onClick={() => void Promise.all([loadEngines(), loadModels()])}>
          Refresh
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        {engines.length === 0 ? (
          <p className="text-sm text-muted flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Waiting for the engine list…
          </p>
        ) : (
          engines.map((e) => <EngineCard key={e.id} engine={e} />)
        )}
        <div className="border-t border-border pt-4">
          <NumberSetting
            label="Unload an idle engine after"
            value={settings?.idle_unload_minutes}
            min={0}
            max={720}
            suffix="min"
            hint="0 keeps the engine loaded until you unload it or quit."
            onCommit={(v) => void saveSettings({ idle_unload_minutes: v })}
            disabled={!settings}
          />
        </div>
        <div className="border-t border-border pt-4">
          <h3>Transcription models</h3>
          <p className="text-[12.5px] text-muted mt-0.5">faster-whisper models used to transcribe reference recordings. The default is chosen under Advanced.</p>
          <div className="divide-y divide-border">
            {asrModels.map((m) => (
              <ModelRow key={m.id} model={m} note={m.id === settings?.asr_model ? "Default transcription model" : m.description} />
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const USAGE_ROWS: Array<{ key: keyof StorageUsage; label: string; note?: string }> = [
  { key: "models_bytes", label: "Models" },
  { key: "recordings_bytes", label: "Recordings", note: "originals + working copies" },
  { key: "voices_bytes", label: "Voice references" },
  { key: "projects_bytes", label: "Projects", note: "takes + masters" },
  { key: "exports_bytes", label: "Exports" },
  { key: "cache_bytes", label: "Caches", note: "regenerable" },
];

function StorageSection() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setUsage(await api.system.storageUsage());
    } catch (err) {
      handleError(err, "Could not measure storage");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const rows = USAGE_ROWS.map((r) => ({ ...r, bytes: (usage?.[r.key] as number | undefined) ?? null })).filter((r) => r.bytes != null);
  const sum = rows.reduce((a, r) => a + (r.bytes ?? 0), 0);

  const clearCaches = async () => {
    setClearing(true);
    try {
      const r = await api.system.clearCache(["prompts", "peaks", "tmp"]);
      toast.success("Caches cleared", `${formatBytes(r.freed_bytes)} freed`);
      setConfirmClear(false);
      await load();
    } catch (err) {
      handleError(err, "Could not clear caches");
    } finally {
      setClearing(false);
    }
  };

  return (
    <Card
      id="storage"
      title="Storage"
      description={usage ? usage.data_dir : "Measuring…"}
      actions={
        <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={loading} onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {rows.map((r) => (
          <div key={r.key} className="grid grid-cols-[140px_1fr_90px] items-center gap-3 text-[13px]">
            <span>
              {r.label}
              {r.note && <span className="block text-[11.5px] text-muted">{r.note}</span>}
            </span>
            <div className="h-2.5 rounded-full bg-track overflow-hidden" aria-hidden>
              <div className="h-full rounded-full bg-accent" style={{ width: `${sum > 0 ? ((r.bytes ?? 0) / sum) * 100 : 0}%` }} />
            </div>
            <span className="text-right tabular-nums">{formatBytes(r.bytes)}</span>
          </div>
        ))}
        {usage && (
          <p className="text-[12.5px] text-muted">
            {formatBytes(sum)} used by the app · {formatBytes(usage.free_bytes)} free{usage.total_bytes ? ` of ${formatBytes(usage.total_bytes)}` : ""} on this disk.
          </p>
        )}
        <div className="flex items-center gap-2 flex-wrap pt-2">
          <Button icon={<FolderOpen />} disabled={!usage} onClick={() => usage && void api.shell.openPath(usage.data_dir).catch((e) => handleError(e, "Could not open the folder"))}>
            Open data folder
          </Button>
          <Button icon={<Eraser />} disabled={!usage} onClick={() => setConfirmClear(true)}>
            Clear caches
          </Button>
        </div>
      </div>
      <ConfirmDialog open={confirmClear} onCancel={() => setConfirmClear(false)} onConfirm={clearCaches} title="Clear caches?" confirmLabel="Clear caches" busy={clearing}>
        <p>This removes regenerable data only: waveform peaks, engine prompt caches and temporary files. They are rebuilt on demand, so the next generation with a voice may take a little longer.</p>
        <p>
          <strong>Recordings, voices, projects, takes, masters and exports are never deleted here.</strong>
        </p>
      </ConfirmDialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Privacy & network
// ---------------------------------------------------------------------------

function PrivacySection() {
  const settings = useAppStore((s) => s.settings);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const loadDiagnostics = useAppStore((s) => s.loadDiagnostics);
  const [switching, setSwitching] = useState(false);

  const setOffline = async (offline: boolean) => {
    setSwitching(true);
    try {
      await api.system.setOffline(offline);
      await Promise.all([loadSettings(), loadDiagnostics()]);
      toast.success(offline ? "Offline mode on" : "Offline mode off", offline ? "Nothing leaves this computer. Installed models keep working." : "Model downloads are allowed again.");
    } catch (err) {
      handleError(err, "Could not change offline mode");
    } finally {
      setSwitching(false);
    }
  };

  return (
    <Card id="privacy" title="Privacy" description="Everything runs on this computer. No accounts, no telemetry, no cloud — the network is only used to download models you approve.">
      <div className="flex flex-col gap-4">
        <Switch
          label="Offline mode"
          description="Blocks all network access. Voice Studio keeps working with the models already installed; downloads wait until you turn this off."
          checked={settings?.offline ?? false}
          onChange={(v) => void setOffline(v)}
          disabled={!settings || switching}
        />
        <p className="text-[12.5px] text-muted">Your recordings, voices and speech are stored as ordinary files in the app's data folder and are not encrypted. Use full-disk encryption if others use this computer.</p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Advanced: performance & project defaults
// ---------------------------------------------------------------------------

function PerformanceSection() {
  const settings = useAppStore((s) => s.settings);
  const engines = useAppStore((s) => s.engines);
  const models = useAppStore((s) => s.models);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const defaultEngine = engines.find((e) => e.id === settings?.default_engine);
  const languages = defaultEngine?.capabilities?.languages ?? [];
  const asrModels = models.filter((m) => m.kind === "asr");

  return (
    <Card id="performance" title="Transcription, performance & defaults" description="Defaults for new voices and for projects in the project editor. Speak's own settings are under Speech generation.">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Select
          label="Transcription model"
          value={settings?.asr_model ?? ""}
          options={asrModels.map((m) => ({ value: m.id, label: `${m.id}${m.state === "installed" ? "" : ` (${m.state})`}` }))}
          onChange={(e) => void saveSettings({ asr_model: e.target.value })}
          disabled={!settings || asrModels.length === 0}
          hint="Used to fill in the words of a voice sample. English-only models are faster."
        />
        <Select
          label="Transcription device"
          value={settings?.asr_device ?? "cpu"}
          options={[
            { value: "cpu", label: "CPU (default, keeps VRAM free)" },
            { value: "cuda", label: "CUDA (faster, shares the GPU lock)" },
          ]}
          onChange={(e) => void saveSettings({ asr_device: e.target.value as "cpu" | "cuda" })}
          disabled={!settings}
        />
        <Select
          label="Default engine"
          value={settings?.default_engine ?? ""}
          options={engines.map((e) => ({ value: e.id, label: `${e.name}${e.installed ? "" : " (environment missing)"}` }))}
          onChange={(e) => void saveSettings({ default_engine: e.target.value })}
          disabled={!settings || engines.length === 0}
        />
        {languages.length > 0 ? (
          <Select
            label="Default language for new voices"
            value={settings?.default_language ?? ""}
            options={languages.map((l) => ({ value: l.code, label: `${l.label} (${l.code})` }))}
            onChange={(e) => void saveSettings({ default_language: e.target.value })}
            disabled={!settings}
          />
        ) : (
          <Input
            label="Default language code"
            defaultValue={settings?.default_language ?? "en"}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== settings?.default_language) void saveSettings({ default_language: v });
            }}
            disabled={!settings}
            hint="Short code such as en."
          />
        )}
        <NumberSetting
          label="Concurrent GPU jobs"
          value={settings?.gpu_jobs}
          min={1}
          max={4}
          hint="Keep 1 unless you have VRAM to spare; more than one engine may be loaded at once."
          onCommit={(v) => void saveSettings({ gpu_jobs: v })}
          disabled={!settings}
        />
        <NumberSetting
          label="Project default: max characters per segment"
          value={settings?.max_chars_per_segment}
          min={40}
          max={2000}
          hint="Clamped to the engine's own limit when planning."
          onCommit={(v) => void saveSettings({ max_chars_per_segment: v })}
          disabled={!settings}
        />
        <NumberSetting label="Project default: paragraph pause" value={settings?.paragraph_pause_ms} min={0} max={5000} step={50} suffix="ms" onCommit={(v) => void saveSettings({ paragraph_pause_ms: v })} disabled={!settings} />
        <NumberSetting label="Project default: sentence pause" value={settings?.sentence_pause_ms} min={0} max={3000} step={10} suffix="ms" onCommit={(v) => void saveSettings({ sentence_pause_ms: v })} disabled={!settings} />
      </div>
    </Card>
  );
}

function RecordingFormat() {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Select
        label="Recording sample rate"
        value={String(settings?.record_sample_rate ?? 48000)}
        options={[44100, 48000, 96000].map((r) => ({ value: String(r), label: `${r} Hz${r === 48000 ? " (recommended)" : ""}` }))}
        onChange={(e) => void saveSettings({ record_sample_rate: Number(e.target.value) }, { silent: true })}
        disabled={!settings}
      />
      <Select
        label="Recording bit depth"
        value={settings?.record_subtype ?? "PCM_24"}
        options={[
          { value: "PCM_16", label: "16-bit PCM" },
          { value: "PCM_24", label: "24-bit PCM (recommended)" },
          { value: "FLOAT", label: "32-bit float" },
        ]}
        onChange={(e) => void saveSettings({ record_subtype: e.target.value }, { silent: true })}
        disabled={!settings}
      />
    </div>
  );
}

function ToolsSection() {
  const navigate = useAppStore((s) => s.navigate);
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const [bundling, setBundling] = useState(false);
  const exportBundle = async () => {
    setBundling(true);
    try {
      const r = await api.system.logBundle();
      toast.success("Diagnostics bundle written", r.path, { action: { label: "Show in folder", onClick: () => void api.shell.revealPath(r.path) } });
    } catch (err) {
      handleError(err, "Could not create the diagnostics bundle");
    } finally {
      setBundling(false);
    }
  };
  return (
    <Card id="tools" title="Tools">
      <div className="flex flex-col gap-4">
        <ToolRow title="Projects and the project editor" text="Long scripts as saved projects: per-sentence takes, comparing engines, backups and detailed exports." action={<Button onClick={() => navigate("projects")} icon={<FolderOpen />}>Open Projects</Button>} />
        <ToolRow title="System check" text="FFmpeg, NVIDIA GPU and CUDA, the engine runtime, audio devices and storage." action={<Button onClick={() => navigate("setup")} icon={<Cpu />}>Run System Check</Button>} />
        <ToolRow title="Diagnostics bundle" text="A zip with redacted logs and a system report, written to the exports folder. Nothing is uploaded." action={<Button onClick={() => void exportBundle()} loading={bundling} icon={<Archive />}>Export Bundle</Button>} />
        <Switch
          label="Redact logs"
          description="Strips user paths and names from worker logs. Applies when the worker next starts."
          checked={settings?.redact_logs ?? true}
          onChange={(v) => void saveSettings({ redact_logs: v })}
          disabled={!settings}
        />
      </div>
    </Card>
  );
}

function ToolRow({ title, text, action }: { title: string; text: string; action: ReactNode }) {
  return (
    <div className="flex items-center gap-4 flex-wrap">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-[14px]">{title}</p>
        <p className="text-[12.5px] text-muted mt-0.5">{text}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const ADVANCED_SECTIONS = new Set(["speech", "export", "engines", "models", "recording", "storage", "performance", "tools", "advanced"]);

export default function SettingsPage() {
  const params = useAppStore((s) => s.params);
  const [advanced, setAdvanced] = useState(() => ADVANCED_SECTIONS.has(params.section ?? ""));
  useEffect(() => {
    if (!params.section) return;
    if (ADVANCED_SECTIONS.has(params.section)) setAdvanced(true);
    const id = params.section === "models" ? "engines" : params.section;
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [params.section]);

  return (
    <div className="flex flex-col gap-6 max-w-[880px] mx-auto">
      <h1 className="text-[26px]">Settings</h1>
      <Card id="general" title="Speech">
        <SpeechBasics />
      </Card>
      <PrivacySection />
      <Card id="audio" title="Microphone & speakers">
        <AudioDevices simple showRecordFormat={false} />
      </Card>

      <Collapsible title="Advanced" description="For experienced users — the defaults work well." open={advanced} onOpenChange={setAdvanced} className="shadow-none">
        <div className="flex flex-col gap-6 pt-4" id="advanced">
          <Card id="speech" title="Speech generation" description="How Speak turns text into speech: engine, language, the engine's own settings, pauses and pronunciation.">
            <SpeakAdvanced />
          </Card>
          <Card id="export" title="Save Audio details">
            <SaveAudioAdvanced />
          </Card>
          <EnginesSection />
          <Card id="recording" title="Recording format" description="The recorder negotiates the closest format the microphone supports.">
            <RecordingFormat />
          </Card>
          <PerformanceSection />
          <StorageSection />
          <ToolsSection />
        </div>
      </Collapsible>
    </div>
  );
}
