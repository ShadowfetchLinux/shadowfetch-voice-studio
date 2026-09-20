import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/Feedback";
import { Spinner } from "@/components/ui/Spinner";
import { useAppStore } from "@/store/appStore";
import { capsFor, useCreateStore } from "@/features/create/createStore";
import { useAutosave } from "@/features/create/useAutosave";
import { useCreateShortcuts } from "@/features/create/useCreateShortcuts";
import { segmentsInSelection } from "@/features/create/planMath";
import { ProjectBar } from "@/features/create/components/ProjectBar";
import { ScriptEditor } from "@/features/create/components/ScriptEditor";
import { SegmentList } from "@/features/create/components/SegmentList";
import { VoicePanel } from "@/features/create/components/VoicePanel";
import { EnginePanel } from "@/features/create/components/EnginePanel";
import { ActionsRow } from "@/features/create/components/ActionsRow";
import { ProgressPanel } from "@/features/create/components/ProgressPanel";
import { CompareEngines } from "@/features/create/components/CompareEngines";
import { MasterPlayer, TakeDrawer, TakePreviewPlayer } from "@/features/create/components/Players";

/**
 * Create page: script editor (hero) + segment list on the left, voice/engine setup on the right,
 * actions and progress in between, master player and take drawer at the bottom.
 */
export default function CreatePage() {
  const params = useAppStore((s) => s.params);
  const engines = useAppStore((s) => s.engines);
  const projectId = useCreateStore((s) => s.projectId);
  const projectLoading = useCreateStore((s) => s.projectLoading);
  const projects = useCreateStore((s) => s.projects);
  const script = useCreateStore((s) => s.script);
  const segments = useCreateStore((s) => s.segments);
  const selection = useCreateStore((s) => s.selection);
  const engineId = useCreateStore((s) => s.engineId);
  const job = useCreateStore((s) => s.job);
  const loadProjects = useCreateStore((s) => s.loadProjects);
  const loadVoices = useCreateStore((s) => s.loadVoices);
  const openProject = useCreateStore((s) => s.openProject);
  const cancelJob = useCreateStore((s) => s.cancelJob);
  const [openNew, setOpenNew] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useAutosave();
  const requestCancel = useCallback(() => setConfirmCancel(true), []);
  useCreateShortcuts(requestCancel);

  // Initial data + route params (projectId to open, action "new" to create).
  useEffect(() => {
    void loadVoices();
    void loadProjects().then((list) => {
      const s = useCreateStore.getState();
      if (params.projectId && params.projectId !== s.projectId) void openProject(params.projectId);
      else if (!s.projectId && list[0] && params.action !== "new") void openProject(list[0].id);
    });
    if (params.action === "new") setOpenNew(true);
  }, [params.projectId, params.action, loadProjects, loadVoices, openProject]);

  const caps = useMemo(() => capsFor(engineId), [engineId, engines]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectedIndexes = useMemo(() => segmentsInSelection(script, selection, segments), [script, selection, segments]);

  return (
    <div className="flex flex-col gap-4">
      <ProjectBar openNew={openNew} onOpenNewHandled={() => setOpenNew(false)} />
      {projectLoading && (
        <p className="text-sm text-muted flex items-center gap-2">
          <Spinner /> Opening project…
        </p>
      )}
      {!projectId && !projectLoading && projects.length === 0 && (
        <div className="panel">
          <EmptyState
            icon={<FolderOpen />}
            title="No project yet"
            text="Start a project, write a script, then generate. Each project keeps the script and the audio you make."
            action={
              <Button variant="primary" onClick={() => setOpenNew(true)}>
                New project
              </Button>
            }
          />
        </div>
      )}
      <ActionsRow selectedIndexes={selectedIndexes} onRequestCancel={requestCancel} />
      <ProgressPanel />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 flex flex-col gap-4 min-w-0">
          <Card title="Script" description="The text to speak. Saved automatically as you type.">
            <ScriptEditor />
          </Card>
          <SegmentList selectedIndexes={selectedIndexes} />
        </div>
        <div className="flex flex-col gap-4 min-w-0">
          <Card title="Voice">
            <VoicePanel />
          </Card>
          <Card title="Engine">
            <EnginePanel engines={engines} caps={caps} />
          </Card>
          {projectId && <CompareEngines engines={engines} />}
        </div>
      </div>
      <TakePreviewPlayer />
      <MasterPlayer />
      <TakeDrawer />
      <ConfirmDialog
        open={confirmCancel && job != null}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          void cancelJob();
        }}
        title="Cancel the running job?"
        confirmLabel="Cancel job"
        cancelLabel="Keep running"
        destructive
      >
        <p>The worker stops at the next segment boundary. Segments that already finished keep their takes.</p>
      </ConfirmDialog>
    </div>
  );
}
