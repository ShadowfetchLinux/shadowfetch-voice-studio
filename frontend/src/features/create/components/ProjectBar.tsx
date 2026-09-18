import { useEffect, useRef, useState } from "react";
import { Check, Eraser, FileUp, FolderPlus, Pencil, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Input, Select } from "@/components/ui/Field";
import { StatusPill, type PillTone } from "@/components/ui/Feedback";
import { useCreateStore } from "../createStore";
import { wordCount } from "../planMath";
import type { SaveState } from "../types";

const SAVE_LABEL: Record<SaveState, { text: string; tone: PillTone; pulse?: boolean }> = {
  idle: { text: "Saved", tone: "neutral" },
  saved: { text: "Saved", tone: "success" },
  dirty: { text: "Unsaved changes", tone: "warn" },
  saving: { text: "Saving…", tone: "accent", pulse: true },
  error: { text: "Save failed", tone: "danger" },
};

function ProjectName() {
  const project = useCreateStore((s) => s.project);
  const renameProject = useCreateStore((s) => s.renameProject);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  if (!project) return null;
  if (!editing) {
    return (
      <div className="flex items-center gap-1 min-w-0">
        <h2 className="truncate text-[17px]">{project.name}</h2>
        <IconButton
          size="sm"
          label="Rename project"
          onClick={() => {
            setDraft(project.name);
            setEditing(true);
          }}
        >
          <Pencil />
        </IconButton>
      </div>
    );
  }
  const commit = () => {
    setEditing(false);
    void renameProject(draft);
  };
  return (
    <div className="flex items-center gap-1 min-w-0">
      <Input
        ref={inputRef}
        aria-label="Project name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        onBlur={commit}
        inputClassName="h-9 w-[260px]"
      />
      <IconButton size="sm" label="Save name" onMouseDown={(e) => e.preventDefault()} onClick={commit}>
        <Check />
      </IconButton>
      <IconButton size="sm" label="Cancel rename" onMouseDown={(e) => e.preventDefault()} onClick={() => setEditing(false)}>
        <X />
      </IconButton>
    </div>
  );
}

function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const createProject = useCreateStore((s) => s.createProject);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const p = await createProject(name);
    setBusy(false);
    if (p) {
      setName("");
      onClose();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New project"
      description="A project holds one script, its plan, generated takes and the assembled master."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!name.trim()}>
            Create
          </Button>
        </>
      }
    >
      <Input
        label="Project name"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
    </Dialog>
  );
}

export interface ProjectBarProps {
  /** Open the "new project" dialog immediately (route action `new`). */
  openNew?: boolean;
  onOpenNewHandled?: () => void;
}

/** Top bar: project selector/creator, inline rename, autosave pill, import, counts, clear. */
export function ProjectBar({ openNew, onOpenNewHandled }: ProjectBarProps) {
  const projects = useCreateStore((s) => s.projects);
  const projectId = useCreateStore((s) => s.projectId);
  const openProject = useCreateStore((s) => s.openProject);
  const saveState = useCreateStore((s) => s.saveState);
  const script = useCreateStore((s) => s.script);
  const setScript = useCreateStore((s) => s.setScript);
  const importTextFile = useCreateStore((s) => s.importTextFile);
  const busy = useCreateStore((s) => s.job != null);
  const [newOpen, setNewOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);

  useEffect(() => {
    if (openNew) {
      setNewOpen(true);
      onOpenNewHandled?.();
    }
  }, [openNew, onOpenNewHandled]);

  const save = SAVE_LABEL[saveState];
  const words = wordCount(script);

  return (
    <div className="panel px-4 py-3 flex items-center gap-3 flex-wrap">
      <Select
        aria-label="Project"
        options={projects.map((p) => ({ value: p.id, label: p.name }))}
        placeholder={projects.length ? "Choose a project…" : "No projects yet"}
        value={projectId ?? ""}
        onChange={(e) => {
          if (e.target.value) void openProject(e.target.value);
        }}
        selectClassName="w-[240px]"
      />
      <Button size="sm" icon={<FolderPlus />} onClick={() => setNewOpen(true)}>
        New project
      </Button>
      <ProjectName />
      {projectId && (
        <StatusPill tone={save.tone} dot pulse={save.pulse} aria-live="polite" size="sm">
          {save.text}
        </StatusPill>
      )}
      <div className="ml-auto flex items-center gap-3 flex-wrap">
        <span className="text-[12.5px] text-muted tabular-nums" aria-live="polite">
          {words} word{words === 1 ? "" : "s"} · {script.length} character{script.length === 1 ? "" : "s"}
        </span>
        <Button size="sm" icon={<FileUp />} disabled={!projectId || busy} onClick={() => (script.trim() ? setConfirmImport(true) : void importTextFile())}>
          Import text file
        </Button>
        <Button size="sm" variant="ghost" icon={<Eraser />} disabled={!projectId || busy || script.length === 0} onClick={() => setConfirmClear(true)}>
          Clear
        </Button>
      </div>
      <NewProjectDialog open={newOpen} onClose={() => setNewOpen(false)} />
      <ConfirmDialog
        open={confirmClear}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setScript("");
          setConfirmClear(false);
        }}
        title="Clear the script?"
        confirmLabel="Clear"
        destructive
      >
        <p>The editor is emptied and the empty text is autosaved as a new script version. Generated takes stay on disk until you re-plan.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmImport}
        onCancel={() => setConfirmImport(false)}
        onConfirm={() => {
          setConfirmImport(false);
          void importTextFile();
        }}
        title="Replace the script with a file?"
        confirmLabel="Choose file"
      >
        <p>The imported text replaces the current script. Previous versions remain in the project's script history.</p>
      </ConfirmDialog>
    </div>
  );
}
