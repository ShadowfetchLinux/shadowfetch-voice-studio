/**
 * Save Audio: render a Speak result with the existing export pipeline (ffmpeg, atomic write, ffprobe check, optional
 * named loudness target, AI-generated metadata). Defaults come from Settings: 24-bit WAV at the engine's native rate.
 */
import { api } from "@/lib/api";
import type { ExportFormat, ExportRenderParams, Settings, SpeechEntry } from "@/lib/protocol";
import { friendlyError, logWorkerError } from "@/lib/friendlyErrors";
import { toast, useAppStore } from "@/store/appStore";

export const FORMATS: Array<{ id: ExportFormat; label: string; hint: string }> = [
  { id: "wav", label: "WAV", hint: "Best quality" },
  { id: "mp3", label: "MP3", hint: "Small, plays everywhere" },
  { id: "flac", label: "FLAC", hint: "Lossless, smaller than WAV" },
];

/** "Welcome to Shadowfetch. This is…" → "Welcome to Shadowfetch This is" (a readable file name, ≤ 48 chars). */
export function fileNameFor(text: string): string {
  const words = text.replace(/[^\p{L}\p{N}\s'-]+/gu, " ").split(/\s+/).filter(Boolean);
  let name = "";
  for (const w of words) {
    if ((name + " " + w).trim().length > 48) break;
    name = (name + " " + w).trim();
  }
  return name || "Speech";
}

export function defaultFormat(settings: Settings | null): ExportFormat {
  const f = settings?.export_default_format;
  return f === "mp3" || f === "flac" || f === "wav" ? f : "wav";
}

export function renderParams(entry: SpeechEntry, format: ExportFormat, outPath: string, settings: Settings | null): ExportRenderParams {
  const bits = settings?.export_wav_bit_depth;
  const mp3 = settings?.export_mp3_bitrate_kbps;
  const target = settings?.export_loudness_target;
  return {
    project_id: entry.project_id,
    master_path: entry.path,
    format,
    out_path: outPath,
    ...(format === "wav" ? { wav_bit_depth: bits === 16 ? 16 : bits === 32 ? "32f" : 24 } : {}),
    ...(format === "mp3" ? { mp3_bitrate_kbps: mp3 === 128 || mp3 === 256 || mp3 === 320 ? mp3 : 192 } : {}),
    ...(target ? { loudness: { target_id: target } } : {}),
    ai_metadata: settings?.export_ai_metadata ?? true,
  };
}

/** Ask where to save, then export. Resolves with the written path (null when cancelled or failed — failures toast). */
export async function saveSpeech(entry: SpeechEntry, format?: ExportFormat): Promise<string | null> {
  const settings = useAppStore.getState().settings;
  const fmt = format ?? defaultFormat(settings);
  try {
    const out = await api.shell.pickSavePath(fileNameFor(entry.text), fmt);
    if (!out) return null;
    const r = await api.export.render(renderParams(entry, fmt, out, settings));
    const name = r.path.split("/").pop() ?? r.path;
    toast.success("Audio saved", name, { action: { label: "Show in folder", onClick: () => void api.shell.revealPath(r.path).catch(() => undefined) } });
    return r.path;
  } catch (err) {
    logWorkerError("save", err);
    const f = friendlyError(err, "save");
    toast.error(f.title, f.message);
    return null;
  }
}
