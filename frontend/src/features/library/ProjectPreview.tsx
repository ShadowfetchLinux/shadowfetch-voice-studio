import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, AudioLines, Copy, Download, FolderOpen, Pencil, Save, Sparkles, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { ExportRecord, PeakPair, Project, ProjectDetail } from "@/lib/protocol";
import { WorkerError } from "@/lib/protocol";
import { formatBytes, formatDuration, formatRelative } from "@/lib/format";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Input, Textarea } from "@/components/ui/Field";
import { EmptyState, StatusPill } from "@/components/ui/Feedback";
import { Spinner } from "@/components/ui/Spinner";
import { PlayerBar, Waveform, usePlayer } from "@/components/audio";
import { handleError, toast, useAppStore } from "@/store/appStore";
import { TagChipsInput } from "@/features/voices/TagChipsInput";
import { normalizeProjectDetail, type ProjectRow } from "./filtering";
import { ExportDialog } from "./ExportDialog";
import { backupProject } from "./BackupDialogs";

export interface ProjectPreviewProps {
  project: ProjectRow;
  tagSuggestions: string[];
  /** Reload the list (and this preview) after a mutation. */
  onChanged: () => void;
  onDeleted: (id: string) => void;
}

/** Right column: master preview, notes/tags, actions and the exports of one project. */
export function ProjectPreview({ project, tagSuggestions, onChanged, onDeleted }: ProjectPreviewProps) {
  const navigate = useAppStore((s) => s.navigate);
  const routeParams = useAppStore((s) => s.params);
  // The project editor's "Export" hands off with navigate("projects", {projectId, section: "export"}): open the dialog once.
  const handledExportRef = useRef<string | null>(null);
  useEffect(() => {
    if (routeParams.section !== "export" || !project || routeParams.projectId !== project.id) return;
    const key = `${project.id}:${project.master_path ?? ""}`;
    if (handledExportRef.current === key) return;
    handledExportRef.current = key;
    if (project.master_path) setExporting(true);
    else toast.info("No master yet", "Assemble the project in the editor before exporting.");
  }, [routeParams.section, routeParams.projectId, project]);
  const engines = useAppStore((s) => s.engines);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<{ peaks: PeakPair[]; duration: number } | null>(null);
  const [notes, setNotes] = useState(project.notes ?? "");
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(project.name);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    try {
      const raw = await api.projects.get(project.id);
      setDetail(normalizeProjectDetail(raw));
      setDetailError(null);
    } catch (err) {
      setDetail(null);
      setDetailError(WorkerError.from(err).message);
    }
  }, [project.id]);

  useEffect(() => {
    setNotes(project.notes ?? "");
    setNewName(project.name);
  }, [project.id, project.notes, project.name]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    setPeaks(null);
    if (!project.master_path) return;
    let alive = true;
    api.audio
      .peaks({ path: project.master_path, points: 2000 })
      .then((r) => alive && setPeaks({ peaks: r.peaks, duration: r.duration_s }))
      .catch(() => alive && setPeaks(null));
    return () => {
      alive = false;
    };
  }, [project.master_path]);

  const player = usePlayer({ path: project.master_path ?? null });

  const patch = async (p: Parameters<typeof api.projects.update>[0]["patch"], label: string) => {
    setBusy(label);
    try {
      await api.projects.update({ id: project.id, patch: p });
      onChanged();
    } catch (err) {
      handleError(err, `Could not ${label}`);
    } finally {
      setBusy(null);
    }
  };

  const duplicate = async () => {
    setBusy("duplicate");
    try {
      const p = await api.projects.duplicate(project.id);
      toast.success("Project duplicated", p.name);
      onChanged();
    } catch (err) {
      handleError(err, "Could not duplicate the project");
    } finally {
      setBusy(null);
    }
  };

  const archive = async () => {
    setBusy("archive");
    try {
      await api.projects.archive({ id: project.id, archived: !project.archived });
      toast.success(project.archived ? "Project unarchived" : "Project archived", project.name);
      onChanged();
    } catch (err) {
      handleError(err, "Could not change the archive state");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("delete");
    try {
      await api.projects.delete(project.id);
      toast.success("Project deleted", project.name);
      setDeleting(false);
      onDeleted(project.id);
    } catch (err) {
      handleError(err, "Could not delete the project");
    } finally {
      setBusy(null);
    }
  };

  const engineName = engines.find((e) => e.id === project.engine_id)?.name ?? project.engine_id ?? "—";
  const exports: ExportRecord[] = detail?.exports ?? [];

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          {project.name}
          {project.archived && (
            <StatusPill size="sm" tone="neutral">
              archived
            </StatusPill>
          )}
        </span>
      }
      description={`${project.voice_name ?? "No voice"} · ${engineName} · ${project.language.toUpperCase()} · updated ${formatRelative(project.updated_at)}${typeof project.segment_count === "number" ? ` · ${project.generated_count ?? 0} of ${project.segment_count} segments generated` : ""}`}
      actions={
        <Button size="sm" variant="primary" icon={<Sparkles />} onClick={() => navigate("editor", { projectId: project.id })}>
          Open in Editor
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <section aria-label="Master preview" className="flex flex-col gap-2">
          {project.master_path ? (
            <>
              {peaks ? (
                <Waveform peaks={peaks.peaks} duration={peaks.duration} currentTime={player.currentTime} onSeek={player.seek} height={120} label={`Master of ${project.name}`} />
              ) : (
                <div className="flex items-center gap-2 text-muted text-sm h-[120px]">
                  <Spinner /> Loading waveform…
                </div>
              )}
              <PlayerBar player={player} />
              <p className="text-[12px] text-muted truncate" title={project.master_path}>
                {project.master?.duration_s ? `${formatDuration(project.master.duration_s)} · ` : ""}
                {project.master?.sample_rate ? `${project.master.sample_rate} Hz · ` : ""}
                {project.master_path}
              </p>
            </>
          ) : (
            <EmptyState compact icon={<AudioLines />} title="No master yet" text="Generate and assemble the project to hear it here." action={<Button onClick={() => navigate("editor", { projectId: project.id })}>Open in Editor</Button>} />
          )}
        </section>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Project actions">
          <Button size="sm" icon={<Pencil />} onClick={() => setRenaming(true)}>
            Rename
          </Button>
          <Button size="sm" icon={<Copy />} loading={busy === "duplicate"} onClick={() => void duplicate()}>
            Duplicate
          </Button>
          <Button size="sm" icon={project.archived ? <ArchiveRestore /> : <Archive />} loading={busy === "archive"} onClick={() => void archive()}>
            {project.archived ? "Unarchive" : "Archive"}
          </Button>
          <Button size="sm" icon={<Download />} onClick={() => setExporting(true)} disabled={!project.master_path}>
            Export…
          </Button>
          <Button size="sm" icon={<Save />} loading={busy === "backup"} onClick={() => { setBusy("backup"); void backupProject(project).finally(() => setBusy(null)); }}>
            Backup…
          </Button>
          <span className="flex-1" />
          <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => setDeleting(true)}>
            Delete
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Textarea label="Notes" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => { if ((notes.trim() || null) !== (project.notes ?? null)) void patch({ notes: notes.trim() || null }, "save notes"); }} hint="Saved when you leave the field." />
          <TagChipsInput value={project.tags} onChange={(tags) => void patch({ tags }, "update tags")} suggestions={tagSuggestions} />
        </div>

        <section aria-label="Exports" className="flex flex-col gap-2">
          <h3 className="text-[13px] font-medium text-muted uppercase tracking-wide">Exports {detail ? `(${exports.length})` : ""}</h3>
          {detailError ? (
            <p className="text-[12.5px] text-danger">Could not load project details: {detailError}</p>
          ) : !detail ? (
            <p className="text-[12.5px] text-muted">Loading…</p>
          ) : exports.length === 0 ? (
            <p className="text-[12.5px] text-muted">No exports yet. Use Export… to render WAV, FLAC or MP3 files from the master.</p>
          ) : (
            <ul className="divide-y divide-border rounded-[var(--radius-control)] border border-border">
              {exports.map((x) => (
                <li key={x.id} className="flex items-center gap-3 px-3 py-2 text-[12.5px]">
                  <StatusPill size="sm" tone="accent">
                    {x.format.toUpperCase()}
                  </StatusPill>
                  <span className="min-w-0 flex-1 truncate" title={x.path}>
                    {x.path.split(/[\\/]/).pop()}
                  </span>
                  <span className="text-muted tabular-nums shrink-0">
                    {x.size_bytes ? formatBytes(x.size_bytes) : ""}
                    {x.loudness ? ` · ${x.loudness.integrated_lufs.toFixed(1)} LUFS` : ""} · {formatRelative(x.created_at)}
                  </span>
                  <IconButton size="sm" label="Open containing folder" onClick={() => void api.shell.revealPath(x.path).catch((err) => handleError(err, "Could not open the folder"))}>
                    <FolderOpen />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Dialog
        open={renaming}
        onClose={() => setRenaming(false)}
        title="Rename project"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!newName.trim()} loading={busy === "rename"} onClick={() => void patch({ name: newName.trim() }, "rename").then(() => setRenaming(false))}>
              Rename
            </Button>
          </>
        }
      >
        <Input label="Name" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) void patch({ name: newName.trim() }, "rename").then(() => setRenaming(false)); }} />
      </Dialog>

      <ConfirmDialog open={deleting} onCancel={() => setDeleting(false)} onConfirm={remove} title="Delete this project?" confirmLabel="Delete project" destructive busy={busy === "delete"}>
        <p>"{project.name}" and its generated takes, master and export records will be removed. Voices and recordings are not touched; exported files outside the app folder stay where they are.</p>
      </ConfirmDialog>

      <ExportDialog project={exporting ? (project as Project) : null} onClose={() => setExporting(false)} onExported={() => void loadDetail()} />
    </Card>
  );
}
