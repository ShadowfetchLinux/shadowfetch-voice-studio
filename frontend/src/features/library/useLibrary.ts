import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Project, ProjectsListResult } from "@/lib/protocol";
import { WorkerError } from "@/lib/protocol";
import { defaultFilters, folderNames, mergeResults, tagNames, toListParams, type LibraryFilters, type ProjectRow } from "./filtering";

export interface Library {
  filters: LibraryFilters;
  setFilters: (patch: Partial<LibraryFilters>) => void;
  projects: ProjectRow[] | null;
  loading: boolean;
  error: string | null;
  folders: string[];
  tags: string[];
  reload: () => Promise<void>;
}

const QUERY_DEBOUNCE_MS = 250;

/** Project list + filters backed by `projects.list` (+ `library.search` for script text when a query is typed). */
export function useLibrary(): Library {
  const [filters, setFiltersState] = useState<LibraryFilters>(defaultFilters);
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const f = filtersRef.current;
    const gen = ++generation.current;
    setLoading(true);
    try {
      // `folder` is not in the PROTOCOL params type, so the untyped request is used for the list call.
      const listP = api.requestRaw<ProjectsListResult>("projects.list", toListParams(f));
      const searchP = f.query.trim() ? api.library.search(f.query.trim()).then((r) => r.projects as Project[]).catch(() => [] as Project[]) : Promise.resolve([] as Project[]);
      const [listed, searched] = await Promise.all([listP, searchP]);
      if (gen !== generation.current) return;
      setProjects(mergeResults(listed.projects as ProjectRow[], searched as ProjectRow[], f));
      setError(null);
    } catch (err) {
      if (gen !== generation.current) return;
      setError(WorkerError.from(err).message);
      setProjects((p) => p ?? []);
    } finally {
      if (gen === generation.current) setLoading(false);
    }
    void api.library
      .folders()
      .then((r) => setFolders(folderNames(r.folders)))
      .catch(() => undefined);
    void api.library
      .tags()
      .then((r) => setTags(tagNames(r.tags)))
      .catch(() => undefined);
  }, []);

  // Reload when filters change; the free-text query is debounced.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      void reload();
      return;
    }
    const t = window.setTimeout(() => void reload(), filters.query ? QUERY_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(t);
  }, [filters, reload]);

  const setFilters = useCallback((patch: Partial<LibraryFilters>) => setFiltersState((f) => ({ ...f, ...patch })), []);

  return { filters, setFilters, projects, loading, error, folders, tags, reload };
}
