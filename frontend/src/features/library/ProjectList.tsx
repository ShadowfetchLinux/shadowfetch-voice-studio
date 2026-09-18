import { Archive, AudioLines, FolderOpen, Search, Star, X } from "lucide-react";
import { api } from "@/lib/api";
import type { ProjectSort } from "@/lib/protocol";
import { cx, formatDuration, formatRelative } from "@/lib/format";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Select } from "@/components/ui/Field";
import { EmptyState, StatusPill } from "@/components/ui/Feedback";
import { Spinner } from "@/components/ui/Spinner";
import { handleError, useAppStore } from "@/store/appStore";
import type { ArchivedFilter, ProjectRow } from "./filtering";
import type { Library } from "./useLibrary";

export interface ProjectListProps {
  library: Library;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRestore: () => void;
}

const ARCHIVED_OPTIONS: Array<{ value: ArchivedFilter; label: string }> = [
  { value: "active", label: "Active projects" },
  { value: "archived", label: "Archived only" },
  { value: "all", label: "Active + archived" },
];
const SORT_OPTIONS: Array<{ value: ProjectSort; label: string }> = [
  { value: "updated", label: "Last updated" },
  { value: "created", label: "Newest first" },
  { value: "name", label: "Name A–Z" },
];

/** Left column: search + filters and the project rows. */
export function ProjectList({ library, selectedId, onSelect, onRestore }: ProjectListProps) {
  const { filters, setFilters, projects, loading, error, folders, tags } = library;
  const navigate = useAppStore((s) => s.navigate);
  const engines = useAppStore((s) => s.engines);
  const engineName = (id: string | null | undefined) => engines.find((e) => e.id === id)?.name ?? id ?? null;

  const toggleFavorite = async (p: ProjectRow) => {
    try {
      await api.projects.update({ id: p.id, patch: { favorite: !p.favorite } });
      await library.reload();
    } catch (err) {
      handleError(err, "Could not update the project");
    }
  };

  const hasFilters = filters.query || filters.tags.length > 0 || filters.favoritesOnly || filters.archived !== "active" || filters.folder != null;

  return (
    <Card
      title="Projects"
      description={projects ? `${projects.length} shown` : undefined}
      actions={
        <>
          <Button size="sm" variant="ghost" icon={<Archive />} onClick={onRestore}>
            Restore backup…
          </Button>
          <Button size="sm" variant="primary" onClick={() => navigate("create", { action: "new" })}>
            New project
          </Button>
        </>
      }
      flush
    >
      <div className="px-4 pt-4 pb-3 flex flex-col gap-3 border-b border-border">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted pointer-events-none" aria-hidden />
          <Input aria-label="Search projects" placeholder="Search names, tags, notes and script text…" value={filters.query} onChange={(e) => setFilters({ query: e.target.value })} inputClassName="pl-9" />
          {filters.query && (
            <IconButton size="sm" label="Clear search" onClick={() => setFilters({ query: "" })} className="absolute right-1 top-1/2 -translate-y-1/2">
              <X />
            </IconButton>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Select aria-label="Archived filter" value={filters.archived} options={ARCHIVED_OPTIONS} onChange={(e) => setFilters({ archived: e.target.value as ArchivedFilter })} />
          <Select aria-label="Sort" value={filters.sort} options={SORT_OPTIONS} onChange={(e) => setFilters({ sort: e.target.value as ProjectSort })} />
          {folders.length > 0 && <Select aria-label="Folder" value={filters.folder ?? ""} placeholder="All folders" options={folders.map((f) => ({ value: f, label: f }))} onChange={(e) => setFilters({ folder: e.target.value === "" ? null : e.target.value })} />}
          <Button size="sm" variant={filters.favoritesOnly ? "secondary" : "ghost"} aria-pressed={filters.favoritesOnly} icon={<Star className={cx(filters.favoritesOnly && "fill-current text-warn")} />} onClick={() => setFilters({ favoritesOnly: !filters.favoritesOnly })} className="h-10">
            Favorites
          </Button>
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5" aria-label="Tag filters">
            {tags.map((t) => {
              const on = filters.tags.includes(t);
              return (
                <button key={t} type="button" aria-pressed={on} onClick={() => setFilters({ tags: on ? filters.tags.filter((x) => x !== t) : [...filters.tags, t] })} className={cx("h-7 px-2.5 rounded-full border text-[12px] font-medium", on ? "border-accent bg-accent-soft text-accent" : "border-border-strong text-muted hover:text-text")}>
                  {t}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {loading && !projects ? (
        <div className="flex items-center gap-2 p-5 text-muted text-sm">
          <Spinner /> Loading projects…
        </div>
      ) : error ? (
        <p role="alert" className="p-5 text-sm text-danger">
          Could not load projects: {error}
        </p>
      ) : !projects || projects.length === 0 ? (
        hasFilters ? (
          <EmptyState compact icon={<Search />} title="No projects match" text="Try a different search or clear the filters." action={<Button onClick={() => setFilters({ query: "", tags: [], favoritesOnly: false, archived: "active", folder: null })}>Clear filters</Button>} />
        ) : (
          <EmptyState compact icon={<FolderOpen />} title="No projects yet" text="Create speech from a script on the Create page; projects and their exports appear here." action={<Button variant="primary" onClick={() => navigate("create", { action: "new" })}>Create speech</Button>} />
        )
      ) : (
        <ul className="divide-y divide-border" aria-label="Projects">
          {projects.map((p) => {
            const selected = p.id === selectedId;
            const masterDur = p.master?.duration_s;
            return (
              <li key={p.id} className={cx("flex items-start gap-2 px-3 py-3", selected && "bg-accent-soft/50")}>
                <IconButton size="sm" label={p.favorite ? "Remove from favorites" : "Add to favorites"} aria-pressed={p.favorite} onClick={() => void toggleFavorite(p)} className={cx("mt-0.5", p.favorite ? "text-warn" : "text-muted")}>
                  <Star className={cx(p.favorite && "fill-current")} />
                </IconButton>
                <button type="button" onClick={() => onSelect(selected ? null : p.id)} aria-current={selected ? "true" : undefined} className="min-w-0 flex-1 text-left py-0.5 rounded-[6px]">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{p.name}</span>
                    {p.archived && (
                      <StatusPill size="sm" tone="neutral">
                        archived
                      </StatusPill>
                    )}
                  </span>
                  <span className="block text-[12.5px] text-muted truncate">
                    {formatRelative(p.updated_at)}
                    {typeof masterDur === "number" ? ` · master ${formatDuration(masterDur)}` : p.master_path ? " · master" : " · no master"}
                    {p.voice_name ? ` · ${p.voice_name}` : ""}
                    {p.engine_id ? ` · ${engineName(p.engine_id)}` : ""}
                    {p.folder ? ` · ${p.folder}` : ""}
                  </span>
                  {p.tags.length > 0 && (
                    <span className="flex flex-wrap gap-1 mt-1">
                      {p.tags.map((t) => (
                        <StatusPill key={t} size="sm">
                          {t}
                        </StatusPill>
                      ))}
                    </span>
                  )}
                </button>
                <AudioLines className={cx("size-4 mt-1 shrink-0", p.master_path ? "text-accent" : "text-border-strong")} aria-hidden />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
