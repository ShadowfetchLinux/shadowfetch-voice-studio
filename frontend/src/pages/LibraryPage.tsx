import { useEffect, useMemo, useState } from "react";
import { Library } from "lucide-react";
import { EmptyState } from "@/components/ui/Feedback";
import { useAppStore } from "@/store/appStore";
import { ProjectList, ProjectPreview, RestoreDialog, useLibrary } from "@/features/library";

/** Library: searchable project list on the left, preview + actions for the selected project on the right. */
export default function LibraryPage() {
  const params = useAppStore((s) => s.params);
  const library = useLibrary();
  const [selectedId, setSelectedId] = useState<string | null>(params.projectId ?? null);
  const [restoreOpen, setRestoreOpen] = useState(false);

  useEffect(() => {
    if (params.projectId) setSelectedId(params.projectId);
  }, [params.projectId]);

  const selected = useMemo(() => library.projects?.find((p) => p.id === selectedId) ?? null, [library.projects, selectedId]);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(340px,460px)_minmax(0,1fr)] gap-6 items-start">
      <ProjectList library={library} selectedId={selectedId} onSelect={setSelectedId} onRestore={() => setRestoreOpen(true)} />
      {selected ? (
        <ProjectPreview
          key={selected.id}
          project={selected}
          tagSuggestions={library.tags}
          onChanged={() => void library.reload()}
          onDeleted={() => {
            setSelectedId(null);
            void library.reload();
          }}
        />
      ) : (
        <div className="panel">
          <EmptyState icon={<Library />} title="Select a project" text="Pick a project on the left to preview its master, edit notes and tags, export, back up or open it in Create." />
        </div>
      )}
      <RestoreDialog
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        onRestored={(id) => {
          setSelectedId(id);
          void library.reload();
        }}
      />
    </div>
  );
}
