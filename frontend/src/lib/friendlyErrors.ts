/**
 * Worker error codes and sample-analysis findings → ordinary language.
 *
 * The structured error (code, message, details) is never thrown away: callers keep the `WorkerError`, it is logged to
 * the console, and screens offer it behind a "Technical details" disclosure. Only the headline the user reads changes.
 */
import { WorkerError } from "./protocol";
import type { SampleIssue } from "./protocol";

/** What the user can do next; screens render the matching button. */
export type FriendlyAction = "install-model" | "system-check" | "retry" | "choose-voice" | "choose-file" | "microphone" | "offline";

export interface FriendlyError {
  title: string;
  message: string;
  action?: FriendlyAction;
  /** The original structured error (for the "Technical details" disclosure and logs). */
  code: string;
  technical: string;
}

/** Where the failure happened; changes the wording of a few generic codes. */
export type ErrorContext = "speak" | "clone" | "record" | "import" | "save" | "model" | "general";

const GENERIC: Record<ErrorContext, string> = {
  speak: "Voice Studio couldn't finish this speech.",
  clone: "Voice Studio couldn't create this voice.",
  record: "The recording stopped unexpectedly.",
  import: "Voice Studio couldn't open this audio file.",
  save: "The audio couldn't be saved.",
  model: "The model couldn't be installed.",
  general: "Something went wrong.",
};

export function friendlyError(err: unknown, context: ErrorContext = "general"): FriendlyError {
  const we = WorkerError.from(err);
  const technical = `${we.code}: ${we.message}`;
  const base = { code: String(we.code), technical };
  const f = (title: string, message: string, action?: FriendlyAction): FriendlyError => ({ title, message, action, ...base });
  switch (we.code) {
    case "GPU_OOM":
      return f("Your graphics card ran out of memory", "Your GPU ran out of memory while generating this speech. Close other GPU-heavy applications and try again.", "retry");
    case "MODEL_MISSING":
    case "MODEL_INVALID":
      return context === "clone" || context === "import" || context === "record"
        ? f("A local model is needed", "Voice Studio needs its local speech-recognition model to understand your recording. It is downloaded once and runs on your computer.", "install-model")
        : f("The voice model isn't installed", "The local voice model needs to be installed before Voice Studio can speak.", "install-model");
    case "MODEL_LOAD_FAILED":
      return f("The voice model couldn't start", "The local model failed to load. Try again; if it keeps failing, run the system check in Settings.", "system-check");
    case "ENGINE_UNAVAILABLE":
      return f("Voice Studio isn't fully set up", "The speech engine on this computer isn't installed yet. Run the system check to finish setup.", "system-check");
    case "ENGINE_CRASHED":
      return f("The speech engine stopped", "The speech engine stopped unexpectedly. Anything already finished was kept — press Speak to try again.", "retry");
    case "OFFLINE_BLOCKED":
      return f("Offline mode is on", "Downloading needs the network, and offline mode blocks it. Turn offline mode off to download, then turn it back on.", "offline");
    case "DOWNLOAD_FAILED":
      return f("The download didn't finish", "Check your internet connection and try again. Finished parts are kept, so it resumes where it stopped.", "retry");
    case "DISK_FULL":
      return f("Your disk is full", "There isn't enough free disk space. Free up some space and try again.");
    case "DEVICE_UNAVAILABLE":
      return context === "save"
        ? f("Couldn't play audio", "No audio output was available. Check your speakers or headphones.")
        : f("Can't use that microphone", "Voice Studio can't access that microphone. Choose another microphone or reconnect it.", "microphone");
    case "PERMISSION_DENIED":
      return f("Permission denied", context === "save" ? "Voice Studio can't write to that folder. Choose another place to save." : "Voice Studio can't read that file or folder.");
    case "UNSUPPORTED_FILE":
      return f("That file isn't supported", "Choose an audio file such as WAV, MP3, FLAC, OGG or M4A.", "choose-file");
    case "CORRUPT_FILE":
      return f("That file can't be read", "The audio file seems to be damaged or incomplete. Try another file.", "choose-file");
    case "EMPTY_AUDIO":
      return f("No sound was found", context === "speak" ? "The engine produced no audio for this text. Try rephrasing it." : "Very little speech was detected in this recording.", context === "import" ? "choose-file" : undefined);
    case "FFMPEG_FAILED":
      return f("Audio conversion failed", "FFmpeg couldn't process this audio. Make sure FFmpeg is installed (the system check can tell you).", "system-check");
    case "NOT_FOUND":
      return f("Something is missing", "A file Voice Studio needs is no longer on disk. If you removed files by hand, try again with another voice or recording.");
    case "DB_ERROR":
      return f("Couldn't save your data", "Voice Studio couldn't write to its library. Check that the disk isn't full or read-only.");
    case "INVALID_PARAMS":
      return f(GENERIC[context], we.message);
    default:
      return f(GENERIC[context], "Please try again. If it keeps happening, restart Voice Studio.", "retry");
  }
}

/** Plain-language headline for a sample-analysis finding (see backend analysis.suggest_reference_range). */
export function describeIssue(issue: Pick<SampleIssue, "code">): string {
  switch (issue.code) {
    case "NO_SPEECH":
      return "Very little speech was detected in this recording.";
    case "TOO_SHORT":
      return "This recording is too short. Speak for at least 10 seconds.";
    case "TOO_QUIET":
      return "The recording is very quiet. Move closer to the microphone or choose another sample.";
    case "CLIPPING":
      return "The recording is distorted in places — it was too loud.";
    case "NOISY":
      return "The voice is difficult to hear over the background noise.";
    case "MOSTLY_SILENT":
      return "This recording contains a lot of silence.";
    case "SHORT":
      return "A little more speech would help — 10 to 15 seconds clones best.";
    default:
      return "This recording may not clone well.";
  }
}

/** Log the structured error (the UI shows the friendly version). */
export function logWorkerError(where: string, err: unknown): void {
  const we = WorkerError.from(err);
  if (!we.cancelled) console.warn(`[${where}]`, we.code, we.message, we.details);
}
