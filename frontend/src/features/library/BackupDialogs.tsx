import { useState } from "react";
import { api } from "@/lib/api";
import type { Project } from "@/lib/protocol";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Field";
import { handleError, toast } from "@/store/appStore";

/** Backup one project: pick a .zip destination, then `backup.export`. Returns the written path or null. */
export async function backupProject(project: Project): Promise<string | null> {
  try {
    const out = await api.shell.pickSavePath(`${project.name}-backup`, "zip");
    if (!out) return null;
    const r = await api.backup.export({ project_id: project.id, out_path: out });
    toast.success("Backup written", `${r.path} (${formatBytes(r.size_bytes)})`, { action: { label: "Open containing folder", onClick: () => void api.shell.revealPath(r.path).catch((err) => handleError(err, "Could not open the folder")) } });
    return r.path;
  } catch (err) {
    handleError(err, "Backup failed");
    return null;
  }
}

export interface RestoreDialogProps {
  open: boolean;
  onClose: () => void;
  onRestored: (projectId: string) => void;
}

/**
 * Restore a project from a backup zip (`backup.import`). The shell has no native picker for zip files yet,
 * so the path is typed; the worker validates it (must be an existing zip with a manifest).
 */
export function RestoreDialog({ open, onClose, onRestored }: RestoreDialogProps) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = /^\//.test(path.trim()) && /\.zip$/i.test(path.trim());

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.backup.import(path.trim());
      toast.success("Project restored");
      onRestored(r.project_id);
      setPath("");
      onClose();
    } catch (err) {
      handleError(err, "Restore failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Restore a project backup"
      description="Imports a backup zip written by this app (manifest + audio). The project is added; nothing existing is overwritten."
      locked={busy}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void run()} loading={busy} disabled={!valid}>
            Restore
          </Button>
        </>
      }
    >
      <Input label="Backup file (.zip)" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/you/Documents/my-project-backup.zip" hint="Absolute path. A native file picker for zip files is not available in this shell version." error={path && !valid ? "Enter an absolute path ending in .zip" : undefined} autoFocus />
    </Dialog>
  );
}
