/**
 * Library filter model and the pure helpers around it (unit-tested in src/__tests__/library.filtering.test.tsx).
 *
 * `projects.list` does the heavy lifting (query over name/tags/notes, tags, favorite, archived, folder, sort);
 * `library.search` additionally matches the latest script text, so when a query is present both are
 * combined client-side and re-filtered so every row still honours the active filters.
 */
import type { LibrarySearchParams, Project, ProjectDetail, ProjectSort, ProjectsListParams } from "@/lib/protocol";

export type ArchivedFilter = "active" | "archived" | "all";

export interface LibraryFilters {
  query: string;
  tags: string[];
  favoritesOnly: boolean;
  archived: ArchivedFilter;
  folder: string | null;
  sort: ProjectSort;
}

export const defaultFilters: LibraryFilters = { query: "", tags: [], favoritesOnly: false, archived: "active", folder: null, sort: "updated" };

/** Project summary rows as `projects.list` returns them (`Project` already carries the summary fields). */
export type ProjectRow = Project;

/** Parameters for `projects.list`. `folder` is accepted by the worker but missing from the PROTOCOL params type. */
export type ListParams = ProjectsListParams & { folder?: string };

export function toListParams(f: LibraryFilters): ListParams {
  const p: ListParams = { sort: f.sort };
  const q = f.query.trim();
  if (q) p.query = q;
  if (f.tags.length) p.tags = f.tags;
  if (f.favoritesOnly) p.favorite = true;
  // An explicit JSON null is the only way to ask the worker for both: `undefined` keys are dropped by
  // JSON.stringify in `invoke`, and a missing key means "active only" (ProjectList.archived defaults to False).
  p.archived = f.archived === "all" ? null : f.archived === "archived";
  if (f.folder != null) p.folder = f.folder;
  return p;
}

/** Parameters for `library.search`; archived script-text hits are only returned when asked for. */
export function toSearchParams(f: LibraryFilters): LibrarySearchParams | null {
  const q = f.query.trim();
  if (!q) return null;
  return f.archived === "active" ? { query: q } : { query: q, include_archived: true };
}

/** True when a project satisfies every non-query filter (used to re-check `library.search` hits). */
export function matchesFilters(p: Project, f: LibraryFilters): boolean {
  if (f.archived === "active" && p.archived) return false;
  if (f.archived === "archived" && !p.archived) return false;
  if (f.favoritesOnly && !p.favorite) return false;
  if (f.folder != null && (p.folder ?? "") !== f.folder) return false;
  if (f.tags.length && !f.tags.every((t) => p.tags.includes(t))) return false;
  return true;
}

export function sortProjects<T extends Project>(projects: T[], sort: ProjectSort): T[] {
  const out = [...projects];
  if (sort === "name") out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  else if (sort === "created") out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  else out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return out;
}

/** Union of the filtered list and the full-text hits (deduplicated by id, filters re-applied, sorted). */
export function mergeResults<T extends Project>(listed: T[], searched: T[], f: LibraryFilters): T[] {
  const byId = new Map<string, T>();
  for (const p of listed) byId.set(p.id, p);
  for (const p of searched) if (!byId.has(p.id) && matchesFilters(p, f)) byId.set(p.id, p);
  return sortProjects([...byId.values()], f.sort);
}

/** `projects.get` returns `{project, script, segments, exports}`; fill in the optional collections defensively. */
export function normalizeProjectDetail(raw: ProjectDetail): ProjectDetail {
  return { project: raw.project, script: raw.script ?? null, segments: raw.segments ?? [], exports: raw.exports ?? [] };
}

/** Folder names from `library.folders` (the worker returns `{name,count}` objects; PROTOCOL also allows strings). */
export function folderNames(items: Array<{ name: string; count: number } | string>): string[] {
  return items.map((f) => (typeof f === "string" ? f : f.name)).filter((n) => n !== "");
}

export function tagNames(items: Array<{ name: string; count: number } | string>): string[] {
  return items.map((t) => (typeof t === "string" ? t : t.name));
}
