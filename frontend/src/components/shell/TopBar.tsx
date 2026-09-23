import { ArrowLeft, RefreshCw, Settings } from "lucide-react";
import { api } from "@/lib/api";
import { cx } from "@/lib/format";
import { Button, IconButton } from "@/components/ui/Button";
import { useAppStore, type Page } from "@/store/appStore";

/** Small logo mark (mirrors src-tauri/icons/app-icon.svg). */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id="sfvs-logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#1d4ed8" />
        </linearGradient>
      </defs>
      <rect x="32" y="32" width="448" height="448" rx="104" fill="url(#sfvs-logo-g)" />
      <g stroke="#ffffff" strokeWidth="30" strokeLinecap="round">
        <line x1="126" y1="236" x2="126" y2="276" />
        <line x1="182" y1="192" x2="182" y2="320" />
        <line x1="238" y1="140" x2="238" y2="372" />
        <line x1="294" y1="172" x2="294" y2="340" />
        <line x1="350" y1="214" x2="350" y2="298" />
        <line x1="406" y1="240" x2="406" y2="272" />
      </g>
    </svg>
  );
}

/** The two places a person works in. Everything else lives behind the gear. */
export const PRIMARY_PAGES: Array<{ page: Page; label: string }> = [
  { page: "speak", label: "Speak" },
  { page: "voices", label: "Voices" },
];

const ADVANCED_TITLES: Partial<Record<Page, string>> = { setup: "System check", projects: "Projects", editor: "Project editor" };

/** Top bar: name, Speak | Voices, and the Settings gear. Advanced tools show a way back to Settings. */
export function TopBar() {
  const page = useAppStore((s) => s.page);
  const navigate = useAppStore((s) => s.navigate);
  const mock = useAppStore((s) => s.mock);
  const advanced = ADVANCED_TITLES[page];
  return (
    <header className="flex items-center gap-4 h-14 px-4 sm:px-5 border-b border-border bg-panel/80 backdrop-blur-sm shrink-0">
      <div className="flex items-center gap-2.5 min-w-0">
        <LogoMark size={26} />
        <span className="text-[14px] font-semibold tracking-[0.02em] whitespace-nowrap hidden md:inline">
          SHADOWFETCH <span className="font-normal text-muted">VOICE STUDIO</span>
        </span>
      </div>
      <nav aria-label="Main" className="flex items-center gap-1 rounded-[10px] bg-panel-alt border border-border p-1 md:ml-4">
        {PRIMARY_PAGES.map((p) => (
          <button
            key={p.page}
            type="button"
            aria-current={page === p.page ? "page" : undefined}
            onClick={() => navigate(p.page)}
            className={cx(
              "h-8 px-4 rounded-[7px] text-[14px] font-medium transition-colors",
              page === p.page ? "bg-panel text-text shadow-sm" : "text-muted hover:text-text",
            )}
          >
            {p.label}
          </button>
        ))}
      </nav>
      {advanced && (
        <Button size="sm" variant="ghost" icon={<ArrowLeft />} onClick={() => navigate("settings")} className="hidden sm:inline-flex">
          Settings · {advanced}
        </Button>
      )}
      <div className="flex-1" />
      {mock && (
        <span className="text-[11px] font-semibold uppercase tracking-wide text-warn" title="Browser preview: all data is fake and nothing is saved">
          Preview mock
        </span>
      )}
      <IconButton label="Settings" aria-current={page === "settings" ? "page" : undefined} onClick={() => navigate("settings")} className={cx(page === "settings" && "bg-hover text-text")}>
        <Settings />
      </IconButton>
    </header>
  );
}

/** Shown only when the local worker is not running (restarting, or stopped after repeated crashes). */
export function WorkerBanner() {
  const status = useAppStore((s) => s.workerStatus);
  const booted = useAppStore((s) => s.booted);
  if (!booted || !status || status.running) return null;
  return (
    <div role="status" className="flex items-center justify-center gap-3 px-4 py-2 text-[13px] bg-warn-soft text-text border-b border-border">
      {status.stopped ? "Voice Studio's engine stopped." : "Voice Studio's engine is restarting…"}
      {status.stopped && (
        <Button size="sm" variant="secondary" icon={<RefreshCw />} onClick={() => void api.shell.workerRestart()}>
          Restart
        </Button>
      )}
    </div>
  );
}
