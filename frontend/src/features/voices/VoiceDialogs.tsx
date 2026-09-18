import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Voice } from "@/lib/protocol";
import { WorkerError } from "@/lib/protocol";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Input, Textarea } from "@/components/ui/Field";
import { handleError, toast } from "@/store/appStore";
import { TagChipsInput } from "./TagChipsInput";

export interface EditVoiceDialogProps {
  voice: Voice | null;
  onClose: () => void;
  onSaved: (voice: Voice) => void;
  tagSuggestions?: string[];
}

/** Rename / tags / language / notes → `voices.update`. */
export function EditVoiceDialog({ voice, onClose, onSaved, tagSuggestions = [] }: EditVoiceDialogProps) {
  const [name, setName] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [language, setLanguage] = useState("en");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!voice) return;
    setName(voice.name);
    setTags(voice.tags);
    setLanguage(voice.language);
    setNotes(voice.notes ?? "");
  }, [voice]);

  const save = async () => {
    if (!voice) return;
    setBusy(true);
    try {
      const v = await api.voices.update({ id: voice.id, patch: { name: name.trim(), tags, language: language.trim() || voice.language, notes: notes.trim() || null } });
      toast.success("Voice updated", v.name);
      onSaved(v);
      onClose();
    } catch (err) {
      handleError(err, "Could not update the voice");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!voice}
      onClose={onClose}
      title="Edit voice"
      locked={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        <TagChipsInput value={tags} onChange={setTags} suggestions={tagSuggestions} />
        <Input label="Language code" value={language} onChange={(e) => setLanguage(e.target.value)} hint="Engine language code, e.g. en." />
        <Textarea label="Notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
    </Dialog>
  );
}

export interface DeleteVoiceDialogProps {
  voice: Voice | null;
  onClose: () => void;
  onDeleted: (id: string) => void;
}

interface UsedBy {
  id: string;
  name: string;
}

/**
 * Delete flow: first attempt without `force`; when the worker refuses because projects use the voice
 * (`error.details.used_by_projects`), list them and offer "Delete anyway" (force:true).
 */
export function DeleteVoiceDialog({ voice, onClose, onDeleted }: DeleteVoiceDialogProps) {
  const [busy, setBusy] = useState(false);
  const [usedBy, setUsedBy] = useState<UsedBy[] | null>(null);
  useEffect(() => setUsedBy(null), [voice]);

  const run = async (force: boolean) => {
    if (!voice) return;
    setBusy(true);
    try {
      await api.voices.delete({ id: voice.id, force });
      toast.success("Voice deleted", voice.name);
      onDeleted(voice.id);
      onClose();
    } catch (err) {
      const we = WorkerError.from(err);
      const list = Array.isArray(we.details.used_by_projects) ? (we.details.used_by_projects as unknown[]) : null;
      if (list && !force) {
        setUsedBy(list.map((p) => (p && typeof p === "object" ? { id: String((p as UsedBy).id ?? ""), name: String((p as UsedBy).name ?? (p as UsedBy).id ?? "project") } : { id: String(p), name: String(p) })));
      } else {
        handleError(err, "Could not delete the voice");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog open={!!voice} onCancel={onClose} onConfirm={() => run(usedBy != null)} title={usedBy ? "Delete anyway?" : "Delete this voice?"} confirmLabel={usedBy ? "Delete anyway" : "Delete"} destructive busy={busy}>
      {voice && (
        <>
          <p>
            "{voice.name}" and its {voice.references?.length ?? 0} reference variant{(voice.references?.length ?? 0) === 1 ? "" : "s"} will be removed. Recordings and imported files stay on disk; only the derived engine files are deleted.
          </p>
          {usedBy && (
            <>
              <p className="text-warn font-medium">
                This voice is used by {usedBy.length} project{usedBy.length === 1 ? "" : "s"}:
              </p>
              <ul className="list-disc pl-5">
                {usedBy.map((p) => (
                  <li key={p.id}>{p.name}</li>
                ))}
              </ul>
              <p>Those projects keep their generated takes but lose the voice link.</p>
            </>
          )}
        </>
      )}
    </ConfirmDialog>
  );
}
