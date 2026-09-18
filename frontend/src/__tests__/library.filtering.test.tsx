import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, Settings } from "@/lib/protocol";

const h = vi.hoisted(async () => {
  const { createEventBus, makeApiModule } = await import("@/features/voices/testSupport");
  const bus = createEventBus();
  return { bus, mod: makeApiModule(bus) };
});
vi.mock("@/lib/api", async () => (await h).mod);

import { defaultFilters, matchesFilters, mergeResults, normalizeProjectDetail, sortProjects, toListParams, toSearchParams } from "@/features/library/filtering";
import LibraryPage from "@/pages/LibraryPage";
import { useAppStore } from "@/store/appStore";

const base: Project = { id: "p", name: "P", folder: "", tags: [], favorite: false, archived: false, language: "en", settings: {}, plan_version: 1, master_path: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" };
const proj = (over: Partial<Project>): Project => ({ ...base, ...over });
const P1 = proj({ id: "p1", name: "Alpha intro", tags: ["podcast"], favorite: true, created_at: "2026-02-15T00:00:00Z", updated_at: "2026-03-01T00:00:00Z", master_path: "/data/projects/p1/master.wav", master: { duration_s: 83.2, sample_rate: 24000 }, voice_name: "Me", engine_id: "qwen3-tts-base" });
const P2 = proj({ id: "p2", name: "Beta chapter", tags: ["audiobook"], updated_at: "2026-02-01T00:00:00Z", folder: "Books" });
const P3 = proj({ id: "p3", name: "Gamma archived", archived: true, updated_at: "2026-04-01T00:00:00Z", created_at: "2026-03-30T00:00:00Z" });

describe("library filtering (pure)", () => {
  it("maps filters to projects.list params", () => {
    expect(toListParams(defaultFilters)).toEqual({ sort: "updated", archived: false });
    expect(toListParams({ query: " fox ", tags: ["a"], favoritesOnly: true, archived: "archived", folder: "Books", sort: "name" })).toEqual({ query: "fox", tags: ["a"], favorite: true, archived: true, folder: "Books", sort: "name" });
    // "Active + archived" must send an explicit null: a missing key means "active only" to the worker.
    expect(toListParams({ ...defaultFilters, archived: "all" })).toEqual({ sort: "updated", archived: null });
    expect(Object.keys(JSON.parse(JSON.stringify(toListParams({ ...defaultFilters, archived: "all" }))))).toContain("archived");
  });

  it("asks library.search for archived script hits only when the filter includes them", () => {
    expect(toSearchParams(defaultFilters)).toBeNull();
    expect(toSearchParams({ ...defaultFilters, query: " fox " })).toEqual({ query: "fox" });
    expect(toSearchParams({ ...defaultFilters, query: "fox", archived: "all" })).toEqual({ query: "fox", include_archived: true });
    expect(toSearchParams({ ...defaultFilters, query: "fox", archived: "archived" })).toEqual({ query: "fox", include_archived: true });
  });

  it("re-applies non-query filters to full-text hits and merges without duplicates", () => {
    expect(matchesFilters(P3, defaultFilters)).toBe(false);
    expect(matchesFilters(P3, { ...defaultFilters, archived: "archived" })).toBe(true);
    expect(matchesFilters(P1, { ...defaultFilters, favoritesOnly: true })).toBe(true);
    expect(matchesFilters(P2, { ...defaultFilters, favoritesOnly: true })).toBe(false);
    expect(matchesFilters(P2, { ...defaultFilters, folder: "Books" })).toBe(true);
    expect(matchesFilters(P2, { ...defaultFilters, tags: ["audiobook", "x"] })).toBe(false);
    const merged = mergeResults([P2], [P1, P2, P3], defaultFilters);
    expect(merged.map((p) => p.id)).toEqual(["p1", "p2"]); // P3 dropped (archived), sorted by updated desc
  });

  it("sorts by updated, created or name", () => {
    expect(sortProjects([P2, P1, P3], "updated").map((p) => p.id)).toEqual(["p3", "p1", "p2"]);
    expect(sortProjects([P2, P1, P3], "created").map((p) => p.id)).toEqual(["p3", "p1", "p2"]);
    expect(sortProjects([P2, P3, P1], "name").map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("normalises the projects.get shape {project, script, segments, exports}", () => {
    const d = normalizeProjectDetail({ project: P1, script: { text: "hi", version: 2 }, segments: [], exports: [{ id: "e1", project_id: "p1", path: "/x.wav", format: "wav", created_at: "" }] });
    expect(d.project.id).toBe("p1");
    expect(d.exports).toHaveLength(1);
    expect(d.script?.text).toBe("hi");
    const bare = normalizeProjectDetail({ project: P2, script: null } as unknown as Parameters<typeof normalizeProjectDetail>[0]);
    expect(bare.project.name).toBe("Beta chapter");
    expect(bare.segments).toEqual([]);
    expect(bare.exports).toEqual([]);
  });
});

describe("<LibraryPage /> with a mocked worker", () => {
  beforeEach(async () => {
    const { mod } = await h;
    vi.clearAllMocks();
    useAppStore.setState({ settings: { export_default_format: "wav", export_wav_bit_depth: 24, export_mp3_bitrate_kbps: 192, export_ai_metadata: true } as Settings, engines: [{ id: "qwen3-tts-base", name: "Qwen3-TTS 1.7B Base", installed: true, state: "unloaded", model_state: "installed" }] });
    mod.api.requestRaw.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method !== "projects.list") return Promise.resolve({});
      let rows = [P1, P2, P3];
      if (params.archived === true) rows = rows.filter((p) => p.archived);
      else if (params.archived === false) rows = rows.filter((p) => !p.archived);
      if (params.favorite === true) rows = rows.filter((p) => p.favorite);
      if (typeof params.query === "string") rows = rows.filter((p) => p.name.toLowerCase().includes(String(params.query).toLowerCase()));
      return Promise.resolve({ projects: rows });
    });
    mod.api.library.search.mockResolvedValue({ projects: [P2], voices: [] });
    mod.api.library.tags.mockResolvedValue({ tags: [{ name: "podcast", count: 1 }, { name: "audiobook", count: 1 }] });
    mod.api.library.folders.mockResolvedValue({ folders: [{ name: "", count: 2 }, { name: "Books", count: 1 }] });
    mod.api.projects.get.mockImplementation((id: string) => Promise.resolve({ project: [P1, P2, P3].find((p) => p.id === id), script: null, segments: [], exports: id === "p1" ? [{ id: "e1", project_id: "p1", path: "/data/exports/Alpha intro.wav", format: "wav", size_bytes: 4_000_000, loudness: { integrated_lufs: -16.2, true_peak_dbtp: -1.1, lra: 6 }, created_at: "2026-03-02T00:00:00Z" }] : [] }));
    mod.api.audio.peaks.mockResolvedValue({ points: 2, duration_s: 83.2, sample_rate: 24000, peaks: [[-0.4, 0.4], [-0.2, 0.2]] });
    mod.api.export.loudnessTargets.mockResolvedValue({ targets: [{ id: "podcast-16", label: "Podcast (-16 LUFS, -1 dBTP)", integrated_lufs: -16, true_peak_dbtp: -1, lra: 11, description: "Common podcast delivery level." }] });
  });

  it("lists active projects, filters by search / favorites / archived and previews the selection", async () => {
    const { mod } = await h;
    const user = userEvent.setup();
    render(<LibraryPage />);
    const list = await screen.findByRole("list", { name: "Projects" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    expect(within(list).getByText("Alpha intro")).toBeInTheDocument();
    expect(within(list).queryByText("Gamma archived")).not.toBeInTheDocument();
    expect(within(list).getByText(/master 1 min 23 s · Me · Qwen3-TTS 1.7B Base/)).toBeInTheDocument();
    expect(within(list).getByText(/no master/)).toBeInTheDocument();
    expect(mod.api.requestRaw).toHaveBeenCalledWith("projects.list", { sort: "updated", archived: false });

    await user.click(screen.getByRole("button", { name: "Favorites" }));
    await waitFor(() => expect(mod.api.requestRaw).toHaveBeenCalledWith("projects.list", { sort: "updated", archived: false, favorite: true }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Projects" })).getAllByRole("listitem")).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Favorites" }));

    await user.selectOptions(screen.getByRole("combobox", { name: "Archived filter" }), "archived");
    await waitFor(() => expect(mod.api.requestRaw).toHaveBeenCalledWith("projects.list", { sort: "updated", archived: true }));
    await waitFor(() => expect(screen.getByText("Gamma archived")).toBeInTheDocument());
    // "Active + archived" sends an explicit null (the worker treats a missing key as "active only")
    await user.selectOptions(screen.getByRole("combobox", { name: "Archived filter" }), "all");
    await waitFor(() => expect(mod.api.requestRaw).toHaveBeenCalledWith("projects.list", { sort: "updated", archived: null }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Projects" })).getAllByRole("listitem")).toHaveLength(3));
    await user.selectOptions(screen.getByRole("combobox", { name: "Archived filter" }), "active");

    await user.type(screen.getByLabelText("Search projects"), "alpha");
    await waitFor(() => expect(mod.api.requestRaw).toHaveBeenCalledWith("projects.list", { sort: "updated", archived: false, query: "alpha" }));
    await waitFor(() => expect(mod.api.library.search).toHaveBeenCalledWith({ query: "alpha" }));
    // the full-text hit (P2, matched in its script) is merged in and still honours the filters
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Projects" })).getAllByRole("listitem")).toHaveLength(2));

    await user.click(within(screen.getByRole("list", { name: "Projects" })).getByText("Beta chapter"));
    expect(await screen.findByText("No master yet")).toBeInTheDocument();
    await user.click(within(screen.getByRole("list", { name: "Projects" })).getByText("Alpha intro"));
    await waitFor(() => expect(mod.api.projects.get).toHaveBeenCalledWith("p1"));
    expect(await screen.findByRole("group", { name: "Playback" })).toBeInTheDocument();
    expect(await screen.findByText(/-16.2 LUFS/)).toBeInTheDocument();
  });

  it("includes archived script-text hits in the search when the filter shows archived projects", async () => {
    const { mod } = await h;
    const user = userEvent.setup();
    render(<LibraryPage />);
    await screen.findByRole("list", { name: "Projects" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Archived filter" }), "all");
    await user.type(screen.getByLabelText("Search projects"), "fox");
    await waitFor(() => expect(mod.api.library.search).toHaveBeenCalledWith({ query: "fox", include_archived: true }));
    expect(mod.api.requestRaw).toHaveBeenCalledWith("projects.list", { sort: "updated", archived: null, query: "fox" });
  });

  it("shows an honest empty state when nothing matches", async () => {
    const { mod } = await h;
    mod.api.requestRaw.mockResolvedValue({ projects: [] });
    mod.api.library.search.mockResolvedValue({ projects: [], voices: [] });
    render(<LibraryPage />);
    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
  });

  it("deletes only after the confirm dialog and exports through pick_save_path → export.render", async () => {
    const { mod } = await h;
    const user = userEvent.setup();
    mod.api.shell.pickSavePath.mockResolvedValue("/home/me/Alpha intro.flac");
    mod.api.export.render.mockResolvedValue({ path: "/home/me/Alpha intro.flac", size_bytes: 2_500_000, probe: { format: "flac", codec: "flac", duration_s: 83.2, sample_rate: 24000, channels: 1, bit_depth: 24, size_bytes: 2_500_000 }, loudness_measured: { integrated_lufs: -16.0, true_peak_dbtp: -1.2, lra: 5.5 } });
    render(<LibraryPage />);
    const list = await screen.findByRole("list", { name: "Projects" });
    await user.click(within(list).getByText("Alpha intro"));
    await screen.findByRole("group", { name: "Project actions" });

    await user.click(screen.getByRole("button", { name: "Export…" }));
    const dialog = await screen.findByRole("dialog", { name: 'Export "Alpha intro"' });
    await user.selectOptions(within(dialog).getByLabelText("Format"), "flac");
    await user.selectOptions(within(dialog).getByLabelText("Sample rate"), "48000");
    expect(within(dialog).getByText(/Upsampling adds no detail/)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText("Loudness normalization")).toBeEnabled());
    await user.selectOptions(within(dialog).getByLabelText("Loudness normalization"), "podcast-16");
    await user.click(within(dialog).getByRole("button", { name: "Choose file and export…" }));
    await waitFor(() => expect(mod.api.shell.pickSavePath).toHaveBeenCalledWith("Alpha intro", "flac"));
    await waitFor(() => expect(mod.api.export.render).toHaveBeenCalledWith({ project_id: "p1", format: "flac", out_path: "/home/me/Alpha intro.flac", sample_rate: 48000, ai_metadata: true, wav_bit_depth: 24, loudness: { target_id: "podcast-16" } }, expect.anything()));
    expect(await within(dialog).findByText(/measured -16.0 LUFS, true peak -1.2 dBTP, LRA 5.5 LU/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Open containing folder" }));
    expect(mod.api.shell.revealPath).toHaveBeenCalledWith("/home/me/Alpha intro.flac");
    await user.click(within(dialog).getByRole("button", { name: "Done" }));

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete this project?" });
    expect(mod.api.projects.delete).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(mod.api.projects.delete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Delete this project?" })).getByRole("button", { name: "Delete project" }));
    await waitFor(() => expect(mod.api.projects.delete).toHaveBeenCalledWith("p1"));
    expect(await screen.findByText("Select a project")).toBeInTheDocument();
  });
});
