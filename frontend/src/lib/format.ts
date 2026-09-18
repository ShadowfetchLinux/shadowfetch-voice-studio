/** Small, dependency-free formatters shared by pages and components. */

/** Human-readable byte size (binary units, 1 decimal above KiB). */
export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = Math.max(0, bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v.toFixed(0) : v.toFixed(digits)} ${units[i]}`;
}

/** Seconds → `m:ss` (or `h:mm:ss`), optionally with tenths. */
export function formatTime(seconds: number | null | undefined, tenths = false): string {
  if (seconds == null || !Number.isFinite(seconds)) return tenths ? "0:00.0" : "0:00";
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const secStr = tenths ? sec.toFixed(1).padStart(4, "0") : Math.floor(sec).toString().padStart(2, "0");
  return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${secStr}` : `${m}:${secStr}`;
}

/** Seconds → short duration text for lists (`12 s`, `3 min 4 s`). */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m} min ${s} s`;
}

/** dBFS value with sign, `-inf` for silence. */
export function formatDbfs(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-inf dBFS";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)} dBFS`;
}

/** ISO timestamp → relative text ("just now", "5 min ago", "yesterday", or a date). */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Math.max(0, now - t) / 1000;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  if (diff < 172800) return "yesterday";
  if (diff < 7 * 86400) return `${Math.round(diff / 86400)} days ago`;
  return new Date(t).toLocaleDateString();
}

/** Percent (0–100) from a measured pair; null when total is unknown or zero. */
export function percent(current: number | null | undefined, total: number | null | undefined): number | null {
  if (current == null || total == null || !(total > 0)) return null;
  return Math.max(0, Math.min(100, (current / total) * 100));
}

/** Class-name joiner that drops falsy values. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Clamp `v` into `[lo, hi]`. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
