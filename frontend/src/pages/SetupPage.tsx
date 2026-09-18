import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, CheckCircle2, Circle, FlaskConical, RefreshCw, TerminalSquare, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import type { CudaSmokeResult } from "@/lib/protocol";
import { cx, formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { StatusPill, type PillTone } from "@/components/ui/Feedback";
import { Spinner } from "@/components/ui/Spinner";
import { AudioDevices } from "@/components/settings/AudioDevices";
import { ModelRow } from "@/components/model-manager/ModelRow";
import { handleError, toast, useAppStore } from "@/store/appStore";

type CheckState = "ok" | "warn" | "missing" | "checking";

const STATE_LABEL: Record<CheckState, { tone: PillTone; text: string; icon: ReactNode }> = {
  ok: { tone: "success", text: "Ready", icon: <CheckCircle2 /> },
  warn: { tone: "warn", text: "Check", icon: <Circle /> },
  missing: { tone: "danger", text: "Missing", icon: <XCircle /> },
  checking: { tone: "neutral", text: "Checking", icon: <Spinner size={14} /> },
};

function Step({ n, title, state, children, description }: { n: number; title: string; state: CheckState; description?: ReactNode; children: ReactNode }) {
  const s = STATE_LABEL[state];
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-3">
          <span className={cx("inline-flex items-center justify-center size-7 rounded-full text-[13px] font-semibold", state === "ok" ? "bg-success text-white" : "bg-black/6 text-muted")}>
            {state === "ok" ? <Check className="size-4" /> : n}
          </span>
          {title}
        </span>
      }
      description={description}
      actions={
        <StatusPill tone={s.tone} icon={s.icon}>
          {s.text}
        </StatusPill>
      }
    >
      {children}
    </Card>
  );
}

const MIN_FREE_BYTES = 5 * 2 ** 30;

function CudaStep() {
  const diagnostics = useAppStore((s) => s.diagnostics);
  const settings = useAppStore((s) => s.settings);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CudaSmokeResult | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const gpu = diagnostics?.gpus[0];
  const engineId = settings?.default_engine ?? "qwen3-tts-base";
  const envProbe = diagnostics?.python.engines["main"];

  // "warn" = GPU present but the real CUDA test has not been run yet.
  const state: CheckState = !diagnostics ? "checking" : result?.ok ? "ok" : !gpu || (result && !result.ok) ? "missing" : "warn";

  const run = async () => {
    setRunning(true);
    setResult(null);
    try {
      const r = await api.system.cudaSmokeTest({ engine_id: engineId }, { onProgress: (p) => setStage(p.message) });
      setResult(r);
      if (r.ok) toast.success("CUDA works", `${r.device} · ${r.matmul_ms} ms matmul`);
      else toast.warning("CUDA test failed", r.error ?? "unknown error");
    } catch (err) {
      const we = handleError(err, "CUDA test could not run");
      setResult({ ok: false, error: we.message });
    } finally {
      setRunning(false);
      setStage(null);
    }
  };

  return (
    <Step n={2} title="GPU and CUDA" state={state} description="Generation runs on the NVIDIA GPU. The smoke test performs a real matmul inside the engine environment.">
      <div className="flex flex-col gap-3 text-sm">
        {!diagnostics ? (
          <p className="text-muted">Reading diagnostics…</p>
        ) : gpu ? (
          <p>
            <span className="font-medium">{gpu.name}</span> · driver {gpu.driver} · {formatBytes(gpu.vram_used_bytes)} / {formatBytes(gpu.vram_total_bytes)} VRAM in use
            {gpu.compute_cap ? ` · compute ${gpu.compute_cap}` : ""}
          </p>
        ) : (
          <p className="text-danger">nvidia-smi found no GPU. The engines will fall back to CPU and be very slow; check the NVIDIA driver installation.</p>
        )}
        {envProbe?.installed && (
          <p className="text-[12.5px] text-muted font-mono">
            main env: torch {envProbe.torch ?? "not importable"} · CUDA {envProbe.cuda_available ? `available (${envProbe.cuda_version ?? "?"})` : "not available"}
            {envProbe.torch_error ? ` · ${envProbe.torch_error}` : ""}
          </p>
        )}
        <div className="flex items-center gap-3 flex-wrap">
          <Button variant="primary" icon={<FlaskConical />} loading={running} disabled={!diagnostics || !envProbe?.installed} onClick={() => void run()} title={!envProbe?.installed ? "Install the Python environments first (step 3)" : undefined}>
            Run CUDA smoke test
          </Button>
          {stage && <span className="text-muted text-[13px]">{stage}</span>}
        </div>
        {result && (
          <div className={cx("rounded-[var(--radius-control)] border px-4 py-3 text-[13px]", result.ok ? "border-success/40 bg-success-soft" : "border-danger/40 bg-danger-soft")} role="status">
            {result.ok ? (
              <p>
                <strong>OK</strong> — {result.device} · torch {result.torch_version} · CUDA {result.cuda_version} · 2048² bf16 matmul in {result.matmul_ms} ms
                {result.vram_free_bytes != null && result.vram_total_bytes != null ? ` · ${formatBytes(result.vram_free_bytes)} of ${formatBytes(result.vram_total_bytes)} free` : ""}
              </p>
            ) : (
              <p>
                <strong>Failed</strong> — {result.error ?? "no details"}
                {result.torch_version ? ` (torch ${result.torch_version}, CUDA ${result.cuda_version ?? "none"})` : ""}
              </p>
            )}
          </div>
        )}
      </div>
    </Step>
  );
}

function EnvStep() {
  const diagnostics = useAppStore((s) => s.diagnostics);
  const loadDiagnostics = useAppStore((s) => s.loadDiagnostics);
  const loadEngines = useAppStore((s) => s.loadEngines);
  const engines = useAppStore((s) => s.engines);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const off = api.events.onRuntimeLog((l) => setLog((prev) => [...prev.slice(-499), l.line]));
    return off;
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const envs = diagnostics?.python.engines ?? {};
  const main = envs["main"];
  const chatterbox = envs["chatterbox"];
  const state: CheckState = !diagnostics ? "checking" : main?.installed && !main.error && !main.torch_error ? "ok" : main?.installed ? "warn" : "missing";

  const bootstrap = async () => {
    setRunning(true);
    setLog([]);
    try {
      await api.shell.runtimeBootstrap();
      toast.success("Environment setup finished");
    } catch (err) {
      handleError(err, "Environment setup failed");
    } finally {
      setRunning(false);
      await Promise.all([loadDiagnostics(), loadEngines()]);
    }
  };

  const envName = (id: string) => engines.find((e) => e.env === id)?.name ?? id;

  return (
    <Step n={3} title="Python engine environments" state={state} description="Each engine runs in its own Python environment with torch. They are created by the bootstrap script.">
      <div className="flex flex-col gap-3 text-sm">
        {Object.entries(envs).map(([id, p]) => (
          <div key={id} className="flex items-center gap-3">
            <StatusPill tone={p.installed && !p.error && !p.torch_error ? "success" : id === "chatterbox" ? "neutral" : "danger"} size="sm">
              {p.installed ? (p.error || p.torch_error ? "broken" : "installed") : "not installed"}
            </StatusPill>
            <span className="font-medium">
              {id} <span className="text-muted font-normal">· {envName(id)}{id === "chatterbox" ? " (optional)" : ""}</span>
            </span>
            <span className="text-[12.5px] text-muted font-mono truncate">
              {p.python ? `python ${p.python}` : ""}
              {p.torch ? ` · torch ${p.torch}` : ""}
              {p.error ?? p.torch_error ?? ""}
            </span>
          </div>
        ))}
        {!diagnostics && <p className="text-muted">Probing environments…</p>}
        {diagnostics && (!main?.installed || !chatterbox?.installed) && (
          <div className="flex items-center gap-3 flex-wrap">
            <Button variant={main?.installed ? "secondary" : "primary"} icon={<TerminalSquare />} loading={running} onClick={() => void bootstrap()}>
              {main?.installed ? "Install optional environments" : "Install environments"}
            </Button>
            <span className="text-[12.5px] text-muted">Downloads Python packages (torch is several GB). Output streams below.</span>
          </div>
        )}
        {(running || log.length > 0) && (
          <pre ref={logRef} className="max-h-56 overflow-auto rounded-[var(--radius-control)] bg-sidebar text-sidebar-text text-[12px] p-3 whitespace-pre-wrap" aria-live="polite" aria-label="Bootstrap log">
            {log.length === 0 ? "Starting…" : log.join("\n")}
          </pre>
        )}
      </div>
    </Step>
  );
}

function ModelsStep() {
  const models = useAppStore((s) => s.models);
  const engines = useAppStore((s) => s.engines);
  const settings = useAppStore((s) => s.settings);
  const defaultEngine = engines.find((e) => e.id === (settings?.default_engine ?? "qwen3-tts-base"));
  const ttsRequired = models.filter((m) => m.kind === "tts" && m.engine_id === (defaultEngine?.id ?? "qwen3-tts-base"));
  const asrRequired = models.filter((m) => m.kind === "asr" && m.id === settings?.asr_model);
  const optional = models.filter((m) => !ttsRequired.includes(m) && !asrRequired.includes(m) && m.kind === "tts");
  const required = [...ttsRequired, ...asrRequired];
  const state: CheckState = models.length === 0 ? "checking" : required.every((m) => m.state === "installed") ? "ok" : required.some((m) => m.state === "downloading") ? "warn" : "missing";

  return (
    <Step n={6} title="Models" state={state} description="Weights are downloaded from Hugging Face after you confirm the license and size. Sizes are estimates until the download completes.">
      <div className="divide-y divide-border">
        {models.length === 0 && (
          <p className="text-sm text-muted py-2 flex items-center gap-2">
            <Spinner /> Loading the model registry…
          </p>
        )}
        {ttsRequired.map((m) => (
          <ModelRow key={m.id} model={m} note={`Required — voice cloning engine (${defaultEngine?.name ?? m.engine_id})`} />
        ))}
        {asrRequired.map((m) => (
          <ModelRow key={m.id} model={m} note="Required — transcribes your reference recording so the engine can clone it" />
        ))}
        {optional.map((m) => (
          <ModelRow key={m.id} model={m} optional note={`Optional — ${m.description ?? "secondary engine"}`} />
        ))}
      </div>
    </Step>
  );
}

export default function SetupPage() {
  const diagnostics = useAppStore((s) => s.diagnostics);
  const loading = useAppStore((s) => s.diagnosticsLoading);
  const loadDiagnostics = useAppStore((s) => s.loadDiagnostics);
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const navigate = useAppStore((s) => s.navigate);
  const models = useAppStore((s) => s.models);
  const [finishing, setFinishing] = useState(false);

  const ffmpegState: CheckState = !diagnostics ? "checking" : diagnostics.ffmpeg && diagnostics.ffprobe ? "ok" : "missing";
  const audio = diagnostics?.audio;
  const audioState: CheckState = !diagnostics ? "checking" : audio?.error ? "missing" : (audio?.inputs.length ?? 0) > 0 && (audio?.outputs.length ?? 0) > 0 ? "ok" : "warn";
  const disk = diagnostics?.disk;
  const storageState: CheckState = !disk ? "checking" : disk.free_bytes >= MIN_FREE_BYTES ? "ok" : "warn";
  const modelsMissing = models.filter((m) => m.kind === "tts" && m.engine_id === (settings?.default_engine ?? "qwen3-tts-base") && m.state !== "installed").length > 0;

  const finish = async () => {
    setFinishing(true);
    const s = await saveSettings({ onboarding_done: true }, { silent: true });
    setFinishing(false);
    if (s) {
      toast.success("Setup complete", modelsMissing ? "You can install the remaining models later from Settings." : undefined);
      navigate("home");
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-[960px]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[20px]">Let's check this machine</h2>
          <p className="text-muted text-sm mt-1">Everything below runs locally. Each step reads the real state from the worker; nothing is assumed.</p>
        </div>
        <Button variant="ghost" icon={<RefreshCw />} loading={loading} onClick={() => void loadDiagnostics()}>
          Re-run checks
        </Button>
      </div>

      <Step n={1} title="FFmpeg" state={ffmpegState} description="Used for decoding, resampling, loudness measurement and exports.">
        {!diagnostics ? (
          <p className="text-sm text-muted">Looking for ffmpeg / ffprobe on PATH…</p>
        ) : diagnostics.ffmpeg && diagnostics.ffprobe ? (
          <p className="text-sm">
            ffmpeg {diagnostics.ffmpeg.version} <span className="text-muted font-mono text-[12.5px]">({diagnostics.ffmpeg.path})</span> · ffprobe {diagnostics.ffprobe.version}
          </p>
        ) : (
          <p className="text-sm">
            <span className="text-danger">ffmpeg{!diagnostics.ffprobe ? " and ffprobe" : ""} not found.</span> Install with <code className="bg-black/6 px-1 rounded">sudo apt install ffmpeg</code>, then re-run the checks.
          </p>
        )}
      </Step>

      <CudaStep />
      <EnvStep />

      <Step n={4} title="Audio devices" state={audioState} description="Pick the microphone you will record with and the output for playback.">
        <AudioDevices showRecordFormat={false} />
      </Step>

      <Step n={5} title="Storage" state={storageState} description="Recordings, voices, projects and models live in the data folder.">
        {!disk ? (
          <p className="text-sm text-muted">Measuring…</p>
        ) : (
          <div className="text-sm flex flex-col gap-1">
            <p>
              <span className="font-mono text-[12.5px] break-all">{diagnostics?.data_dir}</span>
            </p>
            <p>
              {formatBytes(disk.free_bytes)} free of {formatBytes(disk.total_bytes)}.{" "}
              {disk.free_bytes < MIN_FREE_BYTES ? <span className="text-warn">Less than 5 GiB free — the main model alone needs about 4 GiB.</span> : "Enough room for the models and your first projects."}
            </p>
            <p className="text-muted text-[12.5px]">The worker created its folders here when it started, so the location is writable.</p>
          </div>
        )}
      </Step>

      <ModelsStep />

      <div className="panel flex items-center justify-between gap-4 px-5 py-4">
        <div className="text-sm">
          <p className="font-medium">{settings?.onboarding_done ? "Setup was already completed." : "Done checking?"}</p>
          <p className="text-muted text-[13px]">{modelsMissing ? "The voice-cloning model is not installed yet; you can finish now and download it later from Settings." : "You can revisit this checklist any time from Settings."}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" loading={finishing} onClick={() => void finish()} disabled={!settings}>
            {settings?.onboarding_done ? "Back to Home" : "Finish setup"}
          </Button>
        </div>
      </div>
    </div>
  );
}
