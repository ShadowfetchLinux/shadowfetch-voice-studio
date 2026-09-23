import { useEffect, useRef, useState } from "react";
import { Check, Database, Ellipsis, Mic, Pause, Pencil, Play, Plus, Scissors, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { Voice } from "@/lib/protocol";
import { cx, formatDuration } from "@/lib/format";
import { friendlyError, logWorkerError } from "@/lib/friendlyErrors";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Spinner } from "@/components/ui/Spinner";
import { usePlayer, type Selection } from "@/components/audio";
import { toast, useAppStore } from "@/store/appStore";
import { activeReference, sampleAudioPath, sampleSeconds, useVoicesStore } from "@/store/voicesStore";
import { useSpeakStore } from "@/features/speak/speakStore";
import { useCloneStore } from "@/features/voices/cloneStore";
import { EditSampleDialog } from "@/features/voices/EditSampleDialog";
import { DatasetWorkspace } from "@/features/voices/DatasetWorkspace";

function createdLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return `Created ${new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" })}`;
}

interface MenuProps {
  voice: Voice;
  /** A running Speak is using this voice: it cannot be deleted until it finishes. */
  busy: boolean;
  onRename: () => void;
  onAddRecording: () => void;
  onEditSample: () => void;
  onDelete: () => void;
  onDataset: () => void;
}

function VoiceMenu({ voice, busy, onRename, onAddRecording, onEditSample, onDelete, onDataset }: MenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const item = (label: string, icon: React.ReactNode, fn: () => void, danger = false, disabled = false, title?: string) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={() => {
        setOpen(false);
        fn();
      }}
      className={cx("flex w-full items-center gap-2.5 px-3.5 h-9 text-left text-[14px] hover:bg-hover disabled:opacity-50 disabled:hover:bg-transparent [&>svg]:size-4 [&>svg]:shrink-0", danger ? "text-danger" : "")}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label={`More actions for ${voice.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="size-9 inline-flex items-center justify-center rounded-[var(--radius-control)] text-muted hover:bg-hover hover:text-text">
        <Ellipsis className="size-[18px]" />
      </button>
      {open && (
        <div role="menu" aria-label={`${voice.name} actions`} className="absolute right-0 top-[calc(100%+4px)] z-30 w-[220px] panel shadow-[var(--shadow-pop)] py-1.5">
          {item("Rename", <Pencil />, onRename)}
          {item("Add Recording", <Mic />, onAddRecording)}
          {item("Edit Sample", <Scissors />, onEditSample)}
          {item("Delete", <Trash2 />, onDelete, true, busy, busy ? "This voice is speaking right now" : undefined)}
          <div className="my-1.5 h-px bg-border" />
          {item("Export training data…", <Database />, onDataset)}
        </div>
      )}
    </div>
  );
}

/** Voices: your cloned voices — play the sample, use it, rename, add a recording, edit the sample, delete. */
export default function VoicesPage() {
  const navigate = useAppStore((s) => s.navigate);
  const voices = useVoicesStore((s) => s.voices);
  const loaded = useVoicesStore((s) => s.loaded);
  const loadError = useVoicesStore((s) => s.error);
  const load = useVoicesStore((s) => s.load);
  const upsert = useVoicesStore((s) => s.upsert);
  const remove = useVoicesStore((s) => s.remove);
  const speakVoiceId = useSpeakStore((s) => s.voiceId);
  const speaking = useSpeakStore((s) => s.run != null);
  const setVoice = useSpeakStore((s) => s.setVoice);
  const startClone = useCloneStore((s) => s.start);

  const [renaming, setRenaming] = useState<Voice | null>(null);
  const [newName, setNewName] = useState("");
  const [deleting, setDeleting] = useState<Voice | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Voice | null>(null);
  const [dataset, setDataset] = useState<Voice | null>(null);

  // one sample player for the page
  const [sample, setSample] = useState<{ voiceId: string; path: string; selection: Selection } | null>(null);
  const pending = useRef<string | null>(null);
  const player = usePlayer({ path: sample?.path ?? null, selection: sample?.selection ?? null, restrictToSelection: true });
  const { ready, playSelection } = player;
  useEffect(() => {
    if (ready && sample && pending.current === sample.voiceId) {
      pending.current = null;
      void playSelection();
    }
  }, [ready, sample, playSelection]);

  useEffect(() => {
    void load();
  }, [load]);

  const list = voices.filter((v) => !v.archived);

  const playSample = (v: Voice) => {
    const ref = activeReference(v);
    const path = sampleAudioPath(ref);
    if (!ref || !path) return;
    if (sample?.voiceId === v.id && player.playing) {
      player.pause();
      return;
    }
    if (sample?.voiceId === v.id && ready) {
      void playSelection();
      return;
    }
    pending.current = v.id;
    setSample({ voiceId: v.id, path, selection: { start: ref.start_s, end: ref.end_s } });
  };

  const use = async (v: Voice) => {
    await setVoice(v.id);
    navigate("speak");
  };

  const rename = async () => {
    if (!renaming || !newName.trim()) return;
    setBusy(true);
    try {
      upsert(await api.voices.update({ id: renaming.id, patch: { name: newName.trim() } }));
      setRenaming(null);
    } catch (err) {
      logWorkerError("voice.rename", err);
      toast.error("Couldn't rename the voice", friendlyError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      // force: projects that used this voice keep their audio and just lose the link (the Speak scratch project included)
      await api.voices.delete({ id: deleting.id, force: true });
      remove(deleting.id);
      if (sample?.voiceId === deleting.id) setSample(null);
      toast.success("Voice deleted", deleting.name);
      setDeleting(null);
    } catch (err) {
      logWorkerError("voice.delete", err);
      toast.error("Couldn't delete the voice", friendlyError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 sm:px-8 pt-6 pb-10 flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[26px]">Voices</h1>
          <p className="text-[14px] text-muted mt-1">Pick one on the Speak screen, like choosing a font.</p>
        </div>
        <Button variant="primary" size="lg" icon={<Plus />} onClick={() => startClone()}>
          Clone Voice
        </Button>
      </div>

      {loadError && (
        <p role="alert" className="text-sm text-danger">
          {loadError}{" "}
          <button type="button" className="underline" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}

      {!loaded ? (
        <div className="flex items-center gap-2 text-muted text-sm py-10 justify-center">
          <Spinner /> Loading voices…
        </div>
      ) : list.length === 0 ? (
        <div className="panel flex flex-col items-center text-center gap-4 px-8 py-14">
          <span className="inline-flex items-center justify-center size-16 rounded-full bg-accent-soft text-accent">
            <Mic className="size-8" />
          </span>
          <div>
            <h2 className="text-[20px]">No voices yet</h2>
            <p className="text-[14px] text-muted mt-1.5 max-w-[420px]">Clone a voice from a short recording of you speaking, or from an audio file. It takes about a minute.</p>
          </div>
          <Button variant="primary" size="lg" icon={<Plus />} onClick={() => startClone()}>
            Clone Voice
          </Button>
        </div>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" aria-label="Your voices">
          {list.map((v) => {
            const secs = sampleSeconds(v);
            const selected = v.id === speakVoiceId;
            const isPlaying = sample?.voiceId === v.id && player.playing;
            const hasSample = !!sampleAudioPath(activeReference(v));
            return (
              <li key={v.id} className={cx("panel p-5 flex flex-col gap-4", selected && "border-accent/60")}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-[18px] truncate" title={v.name}>
                      {v.name}
                    </h2>
                    <p className="text-[13px] text-muted mt-0.5">
                      {secs != null ? `${formatDuration(secs)} sample` : "No sample"}
                      {v.created_at ? ` · ${createdLabel(v.created_at)}` : ""}
                    </p>
                  </div>
                  <VoiceMenu
                    voice={v}
                    busy={speaking && selected}
                    onRename={() => {
                      setRenaming(v);
                      setNewName(v.name);
                    }}
                    onAddRecording={() => startClone({ kind: "addRecording", voiceId: v.id })}
                    onEditSample={() => setEditing(v)}
                    onDelete={() => setDeleting(v)}
                    onDataset={() => setDataset(v)}
                  />
                </div>
                <div className="flex items-center gap-2 mt-auto">
                  <Button size="sm" variant="secondary" icon={isPlaying ? <Pause /> : <Play />} onClick={() => playSample(v)} disabled={!hasSample} aria-label={`${isPlaying ? "Pause" : "Play"} ${v.name} sample`}>
                    {isPlaying ? "Pause" : "Play Sample"}
                  </Button>
                  <span className="flex-1" />
                  {selected ? (
                    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent">
                      <Check className="size-4" /> In use
                    </span>
                  ) : (
                    <Button size="sm" variant="soft" onClick={() => void use(v)} disabled={speaking || (v.references?.length ?? 0) === 0}>
                      Use Voice
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={!!renaming}
        onClose={() => setRenaming(null)}
        locked={busy}
        title="Rename voice"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!newName.trim()} onClick={() => void rename()}>
              Rename
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void rename();
          }}
        >
          <input className="field-input control text-[15px]" aria-label="Voice name" value={newName} maxLength={60} onChange={(e) => setNewName(e.target.value)} autoFocus />
        </form>
      </Dialog>

      <ConfirmDialog open={!!deleting} onCancel={() => setDeleting(null)} onConfirm={del} title={`Delete ${deleting?.name ?? "this voice"}?`} confirmLabel="Delete Voice" destructive busy={busy}>
        <p>The voice is removed from Voice Studio. Speech you already made stays in Recent, and your original recordings are kept on disk.</p>
      </ConfirmDialog>

      <EditSampleDialog voice={editing} onClose={() => setEditing(null)} />
      {dataset && <DatasetWorkspace voice={dataset} open onClose={() => setDataset(null)} onChanged={() => void load()} />}
    </div>
  );
}
