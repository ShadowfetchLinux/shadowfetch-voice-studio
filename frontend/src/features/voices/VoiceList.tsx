import { useState } from "react";
import { Mic, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { Reference, Voice } from "@/lib/protocol";
import { cx, formatDuration, formatRelative } from "@/lib/format";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState, StatusPill } from "@/components/ui/Feedback";
import { Spinner } from "@/components/ui/Spinner";
import { handleError } from "@/store/appStore";
import { DeleteVoiceDialog, EditVoiceDialog } from "./VoiceDialogs";

export interface VoiceListProps {
  voices: Voice[] | null;
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Start the create-voice flow. Pass `record` / `import` to skip the picker. */
  onNewVoice: (source?: "record" | "import") => void;
  onAddReference: (voice: Voice) => void;
  /** Called after any mutation so the owner reloads the list. */
  onChanged: () => void;
  tagSuggestions?: string[];
}

/** Active reference of a voice (selected id, else the first). */
export function activeReference(v: Voice): Reference | null {
  const refs = v.references ?? [];
  return refs.find((r) => r.id === v.selected_reference_id) ?? refs[0] ?? null;
}

export function referenceDuration(r: Reference | null): number | null {
  return r ? Math.max(0, r.end_s - r.start_s) : null;
}

/** Left column: saved voices with favorite / edit / add reference / delete. */
export function VoiceList({ voices, loading, error, selectedId, onSelect, onNewVoice, onAddReference, onChanged, tagSuggestions }: VoiceListProps) {
  const [editing, setEditing] = useState<Voice | null>(null);
  const [deleting, setDeleting] = useState<Voice | null>(null);

  const toggleFavorite = async (v: Voice) => {
    try {
      await api.voices.update({ id: v.id, patch: { favorite: !v.favorite } });
      onChanged();
    } catch (err) {
      handleError(err, "Could not update the voice");
    }
  };

  return (
    <Card
      title="Your voices"
      description={voices ? `${voices.length} saved` : undefined}
      actions={
        <Button size="sm" variant="primary" icon={<Plus />} onClick={() => onNewVoice()}>
          New voice
        </Button>
      }
      flush
    >
      {loading && !voices ? (
        <div className="flex items-center gap-2 p-5 text-muted text-sm">
          <Spinner /> Loading voices…
        </div>
      ) : error ? (
        <p role="alert" className="p-5 text-sm text-danger">
          Could not load voices: {error}
        </p>
      ) : !voices || voices.length === 0 ? (
        <EmptyState
          compact
          icon={<Mic />}
          title="No voices yet"
          text="Record a short sample with your microphone, or import a clean audio file. Nothing is stored until you save."
          action={
            <>
              <Button variant="primary" icon={<Mic />} onClick={() => onNewVoice("record")}>
                Record
              </Button>
              <Button onClick={() => onNewVoice("import")}>Import file</Button>
            </>
          }
        />
      ) : (
        <ul className="divide-y divide-border" aria-label="Saved voices">
          {voices.map((v) => {
            const ref = activeReference(v);
            const dur = referenceDuration(ref);
            const selected = v.id === selectedId;
            return (
              <li key={v.id} className={cx("flex items-start gap-3 px-4 py-3", selected && "bg-accent-soft/50")}>
                <IconButton size="sm" label={v.favorite ? "Remove from favorites" : "Add to favorites"} aria-pressed={v.favorite} onClick={() => void toggleFavorite(v)} className={cx("mt-0.5", v.favorite ? "text-warn" : "text-muted")}>
                  <Star className={cx(v.favorite && "fill-current")} />
                </IconButton>
                <button type="button" onClick={() => onSelect(selected ? null : v.id)} aria-current={selected ? "true" : undefined} className="min-w-0 flex-1 text-left rounded-[6px] py-0.5">
                  <span className="block text-sm font-medium truncate">{v.name}</span>
                  <span className="block text-[12.5px] text-muted truncate">
                    {v.language.toUpperCase()} · {dur != null ? formatDuration(dur) : "no recording"}
                    {(v.references?.length ?? 0) > 1 ? ` · ${v.references!.length} variants` : ""} · {formatRelative(v.updated_at)}
                  </span>
                  {(v.tags.length > 0 || ref?.label) && (
                    <span className="flex flex-wrap gap-1 mt-1">
                      {ref?.label && (
                        <StatusPill size="sm" tone="accent">
                          {ref.label}
                        </StatusPill>
                      )}
                      {v.tags.map((t) => (
                        <StatusPill key={t} size="sm">
                          {t}
                        </StatusPill>
                      ))}
                    </span>
                  )}
                </button>
                <span className="flex items-center gap-0.5 shrink-0">
                  <IconButton size="sm" label={`Edit ${v.name}`} onClick={() => setEditing(v)}>
                    <Pencil />
                  </IconButton>
                  <IconButton size="sm" label={`Add reference to ${v.name}`} onClick={() => onAddReference(v)}>
                    <Plus />
                  </IconButton>
                  <IconButton size="sm" label={`Delete ${v.name}`} onClick={() => setDeleting(v)}>
                    <Trash2 />
                  </IconButton>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <EditVoiceDialog voice={editing} onClose={() => setEditing(null)} onSaved={onChanged} tagSuggestions={tagSuggestions} />
      <DeleteVoiceDialog
        voice={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={(id) => {
          if (selectedId === id) onSelect(null);
          onChanged();
        }}
      />
    </Card>
  );
}
