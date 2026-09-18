import { useEffect, useState } from "react";
import { GitCompare } from "lucide-react";
import type { EngineInfo } from "@/lib/protocol";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { Collapsible, StatusPill } from "@/components/ui/Feedback";
import { PlayerBar } from "@/components/audio/PlayerBar";
import { usePlayer } from "@/components/audio/usePlayer";
import { useCreateStore } from "../createStore";
import type { CompareEntry } from "../types";

function ComparePlayer({ entry, name, onUse, busy }: { entry: CompareEntry; name: string; onUse: () => void; busy: boolean }) {
  const player = usePlayer({ path: entry.loudness_matched_preview_path ?? entry.path ?? null });
  return (
    <div className="flex flex-col gap-2 min-w-0 rounded-[var(--radius-control)] border border-border p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[13px] font-semibold">{name}</span>
        {entry.error ? (
          <StatusPill tone="danger" size="sm">
            failed · {entry.error.code}
          </StatusPill>
        ) : (
          <StatusPill tone="accent" size="sm">
            loudness-matched preview
          </StatusPill>
        )}
        {entry.duration_s != null && <span className="text-[12px] text-muted tabular-nums">{entry.duration_s.toFixed(1)} s</span>}
        {entry.seed != null && <span className="text-[12px] text-muted tabular-nums">seed {entry.seed}</span>}
      </div>
      {entry.error ? (
        <p className="text-[12.5px] text-danger">{entry.error.message}</p>
      ) : (
        <>
          <PlayerBar player={player} compact />
          <p className="text-[11.5px] text-muted">Preview is level-matched to −18 LUFS for a fair listen; the stored take is untouched.</p>
          <Button size="sm" disabled={busy || !entry.take_id} onClick={onUse} className="self-start">
            Use this take
          </Button>
        </>
      )}
    </div>
  );
}

/** Pick two installed engines and a segment → `tts.compare_engines` → A/B players. */
export function CompareEngines({ engines }: { engines: EngineInfo[] }) {
  const segments = useCreateStore((s) => s.segments);
  const engineId = useCreateStore((s) => s.engineId);
  const job = useCreateStore((s) => s.job);
  const compare = useCreateStore((s) => s.compare);
  const compareEngines = useCreateStore((s) => s.compareEngines);
  const selectTake = useCreateStore((s) => s.selectTake);
  const installed = engines.filter((e) => e.installed && e.model_state === "installed");
  const [a, setA] = useState<string>("");
  const [b, setB] = useState<string>("");
  const [seg, setSeg] = useState<string>("0");

  useEffect(() => {
    const ids = installed.map((e) => e.id);
    setA((cur) => (ids.includes(cur) ? cur : (engineId && ids.includes(engineId) ? engineId : (ids[0] ?? ""))));
    setB((cur) => (ids.includes(cur) && cur !== a ? cur : (ids.find((id) => id !== (engineId ?? ids[0])) ?? "")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engines, engineId]);

  const busy = job != null;
  const canRun = installed.length >= 2 && a && b && a !== b && segments.length > 0 && !busy;
  const nameOf = (id: string) => engines.find((e) => e.id === id)?.name ?? id;
  const segOptions = segments.map((s) => ({ value: String(s.index), label: `#${s.index + 1} · ${s.text.length > 60 ? `${s.text.slice(0, 60)}…` : s.text}` }));

  return (
    <Collapsible title="Compare engines" description="Generate one segment with two engines, one after the other, and listen A/B">
      <div className="flex flex-col gap-3 pt-3">
        {installed.length < 2 ? (
          <p className="text-[12.5px] text-muted">Comparison needs two installed engines with their models. {installed.length === 1 ? "Only one is ready." : "None is ready."}</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            <Select label="Engine A" options={installed.map((e) => ({ value: e.id, label: e.name }))} value={a} onChange={(e) => setA(e.target.value)} disabled={busy} />
            <Select label="Engine B" options={installed.map((e) => ({ value: e.id, label: e.name, disabled: e.id === a }))} value={b} onChange={(e) => setB(e.target.value)} disabled={busy} />
            <Select label="Segment" options={segOptions} placeholder={segOptions.length ? undefined : "Plan first"} value={segOptions.some((o) => o.value === seg) ? seg : (segOptions[0]?.value ?? "")} onChange={(e) => setSeg(e.target.value)} disabled={busy || segOptions.length === 0} />
          </div>
        )}
        <Button icon={<GitCompare />} disabled={!canRun} loading={job?.kind === "compare"} onClick={() => void compareEngines([a, b], parseInt(segOptions.some((o) => o.value === seg) ? seg : (segOptions[0]?.value ?? "0"), 10))} className="self-start">
          Run comparison
        </Button>
        {compare && (
          <div className="flex flex-col gap-2">
            <p className="text-[12.5px] text-muted">Segment {compare.segmentIndex + 1} · engines loaded one at a time; nothing was auto-selected.</p>
            <div className="grid gap-3 md:grid-cols-2">
              {compare.results.map((r, i) => (
                <ComparePlayer key={`${r.engine_id}-${i}`} entry={r} name={`${i === 0 ? "A" : "B"} · ${nameOf(r.engine_id)}`} busy={busy} onUse={() => r.take_id && void selectTake(compare.segmentIndex, r.take_id)} />
              ))}
            </div>
          </div>
        )}
      </div>
    </Collapsible>
  );
}
