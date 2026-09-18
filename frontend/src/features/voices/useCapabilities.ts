import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Capabilities } from "@/lib/protocol";
import { WorkerError } from "@/lib/protocol";
import { useAppStore } from "@/store/appStore";

export interface CapabilitiesState {
  caps: Capabilities | null;
  loading: boolean;
  /** Why capabilities are unavailable (engine env not installed, worker error…). */
  error: string | null;
}

/**
 * Capabilities for one engine: taken from `engine.list` when present, otherwise fetched with
 * `engine.capabilities`. Never fabricated — `caps` stays null with `error` set when the engine cannot answer.
 */
export function useCapabilities(engineId: string | null | undefined): CapabilitiesState {
  const fromList = useAppStore((s) => s.engines.find((e) => e.id === engineId)?.capabilities ?? null);
  const [fetched, setFetched] = useState<{ id: string; caps: Capabilities | null; error: string | null } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!engineId || fromList || (fetched && fetched.id === engineId)) return;
    let alive = true;
    setLoading(true);
    api.engine
      .capabilities(engineId)
      .then((caps) => alive && setFetched({ id: engineId, caps, error: null }))
      .catch((err) => alive && setFetched({ id: engineId, caps: null, error: WorkerError.from(err).message }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [engineId, fromList, fetched]);

  if (!engineId) return { caps: null, loading: false, error: "No engine selected." };
  if (fromList) return { caps: fromList, loading: false, error: null };
  if (fetched && fetched.id === engineId) return { caps: fetched.caps, loading: false, error: fetched.error };
  return { caps: null, loading, error: null };
}
