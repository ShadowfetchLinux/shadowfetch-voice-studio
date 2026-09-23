import { useEffect, useState } from "react";
import { FileAudio, FolderOpen } from "lucide-react";
import { api, events } from "@/lib/api";
import { Button } from "@/components/ui/Button";

/** Audio the import pipeline decodes with FFmpeg (mirrors AUDIO_EXTENSIONS in src-tauri/src/commands.rs). */
export const AUDIO_EXTENSIONS = ["wav", "mp3", "flac", "ogg", "oga", "opus", "m4a", "aac", "aiff", "aif", "webm", "wma"];

export function isAudioPath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.includes(ext);
}

export interface FileStepProps {
  onFile: (path: string) => void;
  /** Shown under the drop zone (e.g. "That file isn't supported"). */
  notice?: string | null;
}

/** "Use Audio File": a drop zone for the whole window plus the native file picker. */
export function FileStep({ onFile, notice }: FileStepProps) {
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(
    () =>
      events.onFileDrop((paths) => {
        const audio = paths.find(isAudioPath);
        if (audio) {
          setDropNotice(null);
          onFile(audio);
        } else setDropNotice("That isn't an audio file Voice Studio can open. Try WAV, MP3, FLAC, OGG or M4A.");
      }),
    [onFile],
  );

  const pick = async () => {
    setPicking(true);
    try {
      const [first] = await api.shell.pickAudioFiles();
      if (first) onFile(first);
    } catch {
      setDropNotice("The file chooser couldn't be opened.");
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-center justify-center gap-3 text-center rounded-[var(--radius-panel)] border-2 border-dashed border-border-strong bg-panel-alt px-6 py-10">
        <FileAudio className="size-10 text-accent" aria-hidden />
        <p className="text-[16px] font-medium">Drop an audio file here</p>
        <p className="text-[13px] text-muted">WAV, MP3, FLAC, OGG, M4A and other common formats. Your file is copied — the original is never changed.</p>
        <Button variant="primary" icon={<FolderOpen />} loading={picking} onClick={() => void pick()}>
          Choose File…
        </Button>
      </div>
      {(notice || dropNotice) && (
        <p role="alert" className="text-[13px] text-danger text-center">
          {notice ?? dropNotice}
        </p>
      )}
    </div>
  );
}
