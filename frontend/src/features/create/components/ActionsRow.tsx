import { useState } from "react";
import { Combine, Download, ListChecks, Play, RefreshCw, Sparkles, Square } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Feedback";
import { formatTime } from "@/lib/format";
import { useAppStore } from "@/store/appStore";
import { useCreateStore } from "../createStore";
import { EST_CHARS_PER_SECOND, allSegmentsHaveTakes, estimateDuration } from "../planMath";

export interface ActionsRowProps {
  /** Segment indexes overlapping the editor selection. */
  selectedIndexes: readonly number[];
  /** Ask before cancelling (shared with the Esc shortcut). */
  onRequestCancel: () => void;
}

/** Plan / Generate preview / Generate full / Regenerate selection / Cancel / Assemble / Export. */
export function ActionsRow({ selectedIndexes, onRequestCancel }: ActionsRowProps) {
  const projectId = useCreateStore((s) => s.projectId);
  const job = useCreateStore((s) => s.job);
  const segments = useCreateStore((s) => s.segments);
  const plan = useCreateStore((s) => s.plan);
  const script = useCreateStore((s) => s.script);
  const engineId = useCreateStore((s) => s.engineId);
  const runPlan = useCreateStore((s) => s.runPlan);
  const generate = useCreateStore((s) => s.generate);
  const assemble = useCreateStore((s) => s.assemble);
  const navigate = useAppStore((s) => s.navigate);
  const [confirmAll, setConfirmAll] = useState(false);

  const busy = job != null;
  const planned = segments.length > 0;
  const canPlan = !!projectId && !busy && script.trim().length > 0 && !!engineId;
  const canGenerate = !!projectId && !busy && (planned || canPlan);
  const canRegenerate = !!projectId && !busy && planned;
  const est = planned ? estimateDuration(segments, plan) : null;
  const withTakes = segments.filter((s) => s.status === "ok").length;

  return (
    <div className="panel px-4 py-3 flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="primary" icon={<Sparkles />} disabled={!canGenerate} loading={job?.kind === "generate" || job?.kind === "plan"} onClick={() => void generate({ mode: "full" })} title="Write a script and pick a voice, then generate. Plans the script first if needed (Ctrl+Enter).">
          Generate
        </Button>
        <Button icon={<Play />} disabled={!canGenerate} onClick={() => void generate({ mode: "preview" })} title="Generate the first line only (Ctrl+Shift+Enter)">
          Preview first line
        </Button>
        <Button variant="ghost" icon={<ListChecks />} disabled={!canPlan} loading={job?.kind === "plan"} onClick={() => void runPlan()} title="Split the script into lines without generating">
          Plan
        </Button>
        <Button variant="ghost" size="sm" disabled={!canRegenerate || withTakes === 0} onClick={() => setConfirmAll(true)} title="Make a new take for every segment, including ones that already have takes">
          Regenerate all
        </Button>
        <Button
          icon={<RefreshCw />}
          disabled={!canRegenerate || selectedIndexes.length === 0}
          onClick={() => void generate({ mode: "indices", indices: [...selectedIndexes] })}
          title={selectedIndexes.length ? `Segments ${selectedIndexes.map((i) => i + 1).join(", ")}` : "Select text in the editor to pick segments"}
        >
          Regenerate selection{selectedIndexes.length ? ` (${selectedIndexes.length})` : ""}
        </Button>
        <Button variant="danger" icon={<Square />} disabled={!busy || job?.cancelling} onClick={onRequestCancel} title="Stop the running job; completed segments stay (Esc)">
          {job?.cancelling ? "Cancelling…" : "Cancel"}
        </Button>
        <span className="mx-1 h-6 w-px bg-border" aria-hidden />
        <Button icon={<Combine />} disabled={!projectId || busy || !allSegmentsHaveTakes(segments)} loading={job?.kind === "assemble"} onClick={() => void assemble()} title="Concatenate the selected takes into master.wav">
          Assemble
        </Button>
        <Button icon={<Download />} disabled={!projectId} onClick={() => projectId && navigate("library", { projectId, section: "export" })} title="Open this project's export in the Library">
          Export
        </Button>
      </div>
      <div className="flex items-center gap-4 flex-wrap text-[12.5px] text-muted">
        {est ? (
          <span className="tabular-nums" title={`${est.measured} segment(s) use measured take durations; ${est.estimated} are estimated at ~${EST_CHARS_PER_SECOND} characters/s; pauses from Segmentation are added.`}>
            {segments.length} segment{segments.length === 1 ? "" : "s"} · approx. {formatTime(est.seconds)}
            {est.estimated > 0 ? ` (${est.estimated} estimated)` : " (measured)"}
          </span>
        ) : (
          <span>Write a script, pick a voice, then Generate.</span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> full · <Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> preview · <Kbd>Esc</Kbd> cancel · <Kbd>Space</Kbd> play master
        </span>
      </div>
      <ConfirmDialog
        open={confirmAll}
        onCancel={() => setConfirmAll(false)}
        onConfirm={() => {
          setConfirmAll(false);
          void generate({ mode: "all" });
        }}
        title="Regenerate every segment?"
        confirmLabel="Regenerate all"
      >
        <p>
          A new take is generated for all {segments.length} segments and becomes the selected one. Existing takes are kept and stay selectable per segment.
        </p>
      </ConfirmDialog>
    </div>
  );
}
