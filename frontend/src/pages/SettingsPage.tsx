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
      title="Engines & models"
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
            <div className="h-2.5 rounded-full bg-black/8 overflow-hidden" aria-hidden>
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
  const saveSettings = useAppStore((s) => s.saveSettings);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const loadDiagnostics = useAppStore((s) => s.loadDiagnostics);
  const [switching, setSwitching] = useState(false);
  const [bundling, setBundling] = useState(false);

  const setOffline = async (offline: boolean) => {
    setSwitching(true);
    try {
      await api.system.setOffline(offline);
      await Promise.all([loadSettings(), loadDiagnostics()]);
      toast.success(offline ? "Offline mode on" : "Offline mode off", offline ? "Downloads are blocked and engine processes start with HF_HUB_OFFLINE=1." : "Model downloads are allowed again.");
    } catch (err) {
      handleError(err, "Could not change offline mode");
    } finally {
      setSwitching(false);
    }
  };

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
    <Card id="privacy" title="Privacy & network" description="The app never sends telemetry. The network is used only for model downloads you approve.">
      <div className="flex flex-col gap-5">
        <Switch
          label="Offline mode"
          description="Blocks every network request: model downloads are refused with OFFLINE_BLOCKED and engine processes start with HF_HUB_OFFLINE=1 / TRANSFORMERS_OFFLINE=1. Turn it on once your models are installed."
          checked={settings?.offline ?? false}
          onChange={(v) => void setOffline(v)}
          disabled={!settings || switching}
        />
        <Switch
          label="Redact logs"
          description="Strips user paths and names from worker logs. Applies when the worker next starts."
          checked={settings?.redact_logs ?? true}
          onChange={(v) => void saveSettings({ redact_logs: v })}
          disabled={!settings}
        />
        <div className="rounded-[var(--radius-control)] border border-border bg-panel-alt px-4 py-3 text-[13px]">
          <p className="font-medium">Local storage is not encrypted</p>
          <p className="text-muted mt-0.5">Recordings, voices and projects live as plain files in the data folder (permissions 0700). Use full-disk encryption if the machine is shared.</p>
        </div>
        <div>
          <Button icon={<Archive />} loading={bundling} onClick={() => void exportBundle()}>
            Export diagnostics bundle
          </Button>
          <p className="text-[12.5px] text-muted mt-1.5">A zip with redacted logs and the diagnostics report, written to the exports folder. Nothing is uploaded.</p>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Advanced
// ---------------------------------------------------------------------------

function AdvancedSection() {
  const settings = useAppStore((s) => s.settings);
  const engines = useAppStore((s) => s.engines);
  const models = useAppStore((s) => s.models);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const params = useAppStore((s) => s.params);
  const defaultEngine = engines.find((e) => e.id === settings?.default_engine);
  const languages = defaultEngine?.capabilities?.languages ?? [];
  const asrModels = models.filter((m) => m.kind === "asr");

  return (
    <Collapsible title="Advanced" description="Defaults for planning and generation. Per-project values override these." defaultOpen={params.section === "advanced"}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3">
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
          label="Max characters per segment"
          value={settings?.max_chars_per_segment}
          min={40}
          max={2000}
          hint="Clamped to the engine's own limit when planning."
          onCommit={(v) => void saveSettings({ max_chars_per_segment: v })}
          disabled={!settings}
        />
        <NumberSetting label="Paragraph pause" value={settings?.paragraph_pause_ms} min={0} max={5000} step={50} suffix="ms" onCommit={(v) => void saveSettings({ paragraph_pause_ms: v })} disabled={!settings} />
        <NumberSetting label="Sentence pause" value={settings?.sentence_pause_ms} min={0} max={3000} step={10} suffix="ms" onCommit={(v) => void saveSettings({ sentence_pause_ms: v })} disabled={!settings} />
        <Select
          label="Default engine"
          value={settings?.default_engine ?? ""}
          options={engines.map((e) => ({ value: e.id, label: `${e.name}${e.installed ? "" : " (environment missing)"}` }))}
          onChange={(e) => void saveSettings({ default_engine: e.target.value })}
          disabled={!settings || engines.length === 0}
        />
        {languages.length > 0 ? (
          <Select
            label="Default language"
            value={settings?.default_language ?? ""}
            options={languages.map((l) => ({ value: l.code, label: `${l.label} (${l.code})` }))}
            onChange={(e) => void saveSettings({ default_language: e.target.value })}
            disabled={!settings}
            hint="Languages declared by the default engine."
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
            hint="Short code such as en. The engine's declared languages appear here once its capabilities are known."
          />
        )}
        <Select
          label="Transcription model"
          value={settings?.asr_model ?? ""}
          options={asrModels.map((m) => ({ value: m.id, label: `${m.id}${m.state === "installed" ? "" : ` (${m.state})`}` }))}
          onChange={(e) => void saveSettings({ asr_model: e.target.value })}
          disabled={!settings || asrModels.length === 0}
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
      </div>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const params = useAppStore((s) => s.params);
  const navigate = useAppStore((s) => s.navigate);
  useEffect(() => {
    if (params.section) document.getElementById(params.section)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [params.section]);

  return (
    <div className="flex flex-col gap-6 max-w-[960px]">
      <Card id="audio" title="Audio devices" description="Devices are read from the worker each time diagnostics run.">
        <AudioDevices />
      </Card>
      <EnginesSection />
      <StorageSection />
      <PrivacySection />
      <AdvancedSection />
      <div className="flex items-center gap-3 text-[13px] text-muted">
        <Cpu className="size-4" />
        <span>Need to re-check FFmpeg, CUDA or the Python environments?</span>
        <Button size="sm" variant="ghost" onClick={() => navigate("setup")}>
          Open the setup checklist
        </Button>
      </div>
    </div>
  );
}
