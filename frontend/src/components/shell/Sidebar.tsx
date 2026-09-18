import { AudioLines, Home, Library, Mic, Settings } from "lucide-react";
import { cx } from "@/lib/format";
import { Kbd } from "@/components/ui/Feedback";
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

export interface NavItem {
  page: Page;
  label: string;
  icon: typeof Home;
  key: string;
}

export const NAV_ITEMS: NavItem[] = [
  { page: "home", label: "Home", icon: Home, key: "1" },
  { page: "voices", label: "Voices", icon: Mic, key: "2" },
  { page: "create", label: "Create", icon: AudioLines, key: "3" },
  { page: "library", label: "Library", icon: Library, key: "4" },
];
export const SETTINGS_ITEM: NavItem = { page: "settings", label: "Settings", icon: Settings, key: "5" };

function NavButton({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cx(
        "group flex items-center gap-3 w-full h-10 px-3 rounded-[var(--radius-control)] text-left text-sm font-medium transition-colors",
        "focus-visible:outline-accent",
        active ? "bg-sidebar-active text-white" : "text-sidebar-text hover:bg-sidebar-hover hover:text-white",
      )}
    >
      <Icon className={cx("size-[18px] shrink-0", active ? "text-white" : "text-sidebar-muted group-hover:text-white")} />
      <span className="flex-1">{item.label}</span>
      <Kbd className="opacity-0 group-hover:opacity-100 bg-transparent border-sidebar-border text-sidebar-muted shadow-none">{item.key}</Kbd>
    </button>
  );
}

/** Left navigation rail. */
export function Sidebar() {
  const page = useAppStore((s) => s.page);
  const navigate = useAppStore((s) => s.navigate);
  return (
    <nav aria-label="Main" className="flex flex-col w-[220px] shrink-0 h-full bg-sidebar text-sidebar-text border-r border-sidebar-border">
      <div className="flex items-center gap-3 px-4 h-16 border-b border-sidebar-border">
        <LogoMark />
        <div className="min-w-0 leading-tight">
          <p className="text-[13px] font-semibold text-white truncate">Shadowfetch</p>
          <p className="text-[11.5px] text-sidebar-muted truncate">Voice Studio</p>
        </div>
      </div>
      <div className="flex flex-col gap-1 p-3">
        {NAV_ITEMS.map((it) => (
          <NavButton key={it.page} item={it} active={page === it.page} onClick={() => navigate(it.page)} />
        ))}
      </div>
      <div className="mt-auto p-3 border-t border-sidebar-border">
        <NavButton item={SETTINGS_ITEM} active={page === "settings" || page === "setup"} onClick={() => navigate("settings")} />
      </div>
    </nav>
  );
}
