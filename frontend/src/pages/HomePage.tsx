import { useEffect, useState } from "react";
import { AudioLines, ChevronRight, Cpu, FolderOpen, HardDrive, Library, Mic, Package, Sparkles, X } from "lucide-react";
import { api } from "@/lib/api";
import type { Project } from "@/lib/protocol";
import { cx, formatBytes, formatRelative } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState, StatusPill } from "@/components/ui/Feedback";
import { Spinner } from "@/components/ui/Spinner";
import { handleError, useLoadedEngine, useAppStore } from "@/store/appStore";

function BigAction({ icon, title, text, onClick, primary }: { icon: React.ReactNode; title: string; text: string; onClick: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "group panel flex flex-col items-start gap-3 p-5 text-left min-h-[136px] transition-colors hover:border-accent focus-visible:border-accent",
        primary && "bg-accent text-white border-accent hover:bg-accent-hover",
      )}
    >
      <span className={cx("inline-flex items-center justify-center size-11 rounded-[10px] [&>svg]:size-6", primary ? "bg-white/15" : "bg-accent-soft text-accent")}>{icon}</span>
      <span className="flex-1">
        <span className="block text-[15px] font-semibold">{title}</span>
        <span className={cx("block text-[13px] mt-0.5", primary ? "text-white/80" : "text-muted")}>{text}</span>
      </span>
      <span className={cx("inline-flex items-center gap-1 text-[13px] font-medium", primary ? "text-white" : "text-accent")}>
        Open <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

function FirstRunBanner() {
  const navigate = useAppStore((s) => s.navigate);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <div className="flex items-center gap-4 rounded-[var(--radius-panel)] border border-accent/30 bg-accent-soft px-5 py-4" role="region" aria-label="First run">
      <Sparkles className="size-5 text-accent shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">A few setup checks are still open</p>
        <p className="text-[13px] text-muted">You can make a voice now. Come back to setup if recording or generation asks for a missing piece.</p>
      </div>
      <Button onClick={() => navigate("setup")}>Setup</Button>
      <Button variant="primary" onClick={() => navigate("voices", { action: "new" })}>
        New voice
      </Button>
      <button type="button" aria-label="Hide for now" onClick={() => setHidden(true)} className="size-9 inline-flex items-center justify-center rounded-md text-muted hover:bg-black/5">
        <X className="size-4" />
      </button>
    </div>
  );
}

function RecentProjects() {
  const navigate = useAppStore((s) => s.navigate);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    api.projects
      .list({ sort: "updated", limit: 6 })
      .then((r) => alive && setProjects(r.projects.slice(0, 6)))
      .catch((err) => {
        handleError(err, "Could not load recent projects");
        if (alive) setProjects([]);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Card
      title="Recent projects"
      actions={
        <Button size="sm" variant="ghost" onClick={() => navigate("library")} iconRight={<ChevronRight />}>
          Library
        </Button>
      }
      flush
    >
      {loading ? (
        <div className="flex items-center gap-2 p-5 text-muted text-sm">
          <Spinner /> Loading…
        </div>
      ) : !projects || projects.length === 0 ? (
        <EmptyState
          compact
          icon={<FolderOpen />}
          title="No projects yet"
          text="After you have a voice, write a script on Create and it will show up here."
          action={
            <Button variant="primary" onClick={() => navigate("create", { action: "new" })}>
              Create speech
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-border">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => navigate("create", { projectId: p.id })}
                className="flex items-center gap-4 w-full px-5 py-3 text-left hover:bg-panel-alt min-h-12"
              >
                <span className="inline-flex items-center justify-center size-9 rounded-[8px] bg-accent-soft text-accent shrink-0">
                  <AudioLines className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium truncate">{p.name}</span>
                  <span className="block text-[12.5px] text-muted truncate">
                    {[p.voice_name, p.master_path ? "audio ready" : null].filter(Boolean).join(" · ") || "No voice selected"}
                  </span>
                </span>
                <span className="text-[12.5px] text-muted shrink-0">{formatRelative(p.updated_at)}</span>
                <ChevronRight className="size-4 text-muted shrink-0" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 min-h-10">
      <span className="text-muted [&>svg]:size-4 shrink-0">{icon}</span>
      <span className="text-[13px] text-muted w-[72px] shrink-0">{label}</span>
      <span className="min-w-0 flex-1 text-sm break-words">{children}</span>
    </div>
  );
}

function SystemStatus() {
  const navigate = useAppStore((s) => s.navigate);
  const diagnostics = useAppStore((s) => s.diagnostics);
  const gpu = useAppStore((s) => s.gpu?.gpus[0] ?? s.diagnostics?.gpus[0] ?? null);
  const loaded = useLoadedEngine();
  const models = useAppStore((s) => s.models);
  const settings = useAppStore((s) => s.settings);

  const required = models.filter((m) => (m.kind === "tts" && m.engine_id === settings?.default_engine) || m.id === settings?.asr_model);
  const installed = models.filter((m) => m.state === "installed");
  const missingRequired = required.filter((m) => m.state !== "installed");

  return (
    <Card
      title="This computer"
      actions={
        <Button size="sm" variant="ghost" onClick={() => navigate("setup")}>
          Setup
        </Button>
      }
    >
      <div className="flex flex-col gap-1">
        <Row icon={<Cpu />} label="GPU">
          {!diagnostics && !gpu ? <span className="text-muted">checking…</span> : gpu ? `${gpu.name} · ${formatBytes(gpu.vram_used_bytes, 1)} / ${formatBytes(gpu.vram_total_bytes, 1)}` : <StatusPill tone="warn" size="sm">not detected</StatusPill>}
        </Row>
        <Row icon={<AudioLines />} label="Engine">
          {loaded ? (
            <StatusPill tone={loaded.state.state === "loading" ? "warn" : "success"} size="sm" dot pulse={loaded.state.state === "loading"}>
              {loaded.state.state === "loading" ? "loading" : "ready"} · {loaded.engine.name}
            </StatusPill>
          ) : (
            <StatusPill tone="neutral" size="sm">
              idle
            </StatusPill>
          )}
        </Row>
        <Row icon={<HardDrive />} label="Disk">
          {diagnostics ? `${formatBytes(diagnostics.disk.free_bytes, 0)} free` : <span className="text-muted">checking…</span>}
        </Row>
        <Row icon={<Package />} label="Models">
          {models.length === 0 ? (
            <span className="text-muted">checking…</span>
          ) : (
            <span className="inline-flex items-center gap-2 flex-wrap">
              <span>
                {installed.length} of {models.length} installed
              </span>
              {missingRequired.length > 0 && (
                <StatusPill tone="warn" size="sm">
                  {missingRequired.length} still needed
                </StatusPill>
              )}
              {missingRequired.length > 0 && (
                <button type="button" className="text-[13px] font-medium text-accent hover:underline" onClick={() => navigate("setup")}>
                  Setup
                </button>
              )}
            </span>
          )}
        </Row>
        {diagnostics?.warnings?.length ? (
          <ul className="mt-2 flex flex-col gap-1">
            {diagnostics.warnings.map((w) => (
              <li key={w} className="text-[12.5px] text-warn">
                {w}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}

export default function HomePage() {
  const navigate = useAppStore((s) => s.navigate);
  const settings = useAppStore((s) => s.settings);
  return (
    <div className="flex flex-col gap-6">
      {settings && !settings.onboarding_done && <FirstRunBanner />}
      <section aria-label="Get started">
        <div className="mb-4">
          <h2 className="text-[17px]">Three steps</h2>
          <p className="text-[13px] text-muted mt-0.5">Make a voice, write a script, then find the audio in the Library.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <BigAction icon={<Mic />} title="New voice" text="Record or import a short sample, trim it, check the words, and save." onClick={() => navigate("voices", { action: "new" })} primary />
          <BigAction icon={<Sparkles />} title="Create speech" text="Write a script and generate audio with a saved voice." onClick={() => navigate("create", { action: "new" })} />
          <BigAction icon={<Library />} title="Library" text="Play, export and back up the speech you have made." onClick={() => navigate("library")} />
        </div>
      </section>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px] gap-6 items-start">
        <RecentProjects />
        <SystemStatus />
      </div>
    </div>
  );
}
