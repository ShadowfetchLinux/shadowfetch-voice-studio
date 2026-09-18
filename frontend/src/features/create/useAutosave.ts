import { useEffect } from "react";
import { AUTOSAVE_DEBOUNCE_MS, useCreateStore } from "./createStore";

/**
 * Debounced autosave: whenever the script differs from the last saved text, `projects.save_script` runs
 * once the user has been idle for `AUTOSAVE_DEBOUNCE_MS` (1.5 s). Unmounting with unsaved changes flushes.
 */
export function useAutosave(): void {
  const projectId = useCreateStore((s) => s.projectId);
  const script = useCreateStore((s) => s.script);
  const savedScript = useCreateStore((s) => s.savedScript);
  const saveScriptNow = useCreateStore((s) => s.saveScriptNow);

  useEffect(() => {
    if (!projectId || script === savedScript) return;
    const t = window.setTimeout(() => void saveScriptNow(), AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [projectId, script, savedScript, saveScriptNow]);

  // Flush on unmount so leaving the page never loses the last edits.
  useEffect(
    () => () => {
      const s = useCreateStore.getState();
      if (s.projectId && s.script !== s.savedScript) void s.saveScriptNow();
    },
    [],
  );
}
