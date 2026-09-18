import { useCallback, useEffect, useRef, type SyntheticEvent } from "react";
import { Textarea } from "@/components/ui/Field";
import { useCreateStore } from "../createStore";
import { registerEditor } from "../editorRef";

/** The hero: a large script textarea (≥16 visible lines) that reports its selection to the store. */
export function ScriptEditor() {
  const script = useCreateStore((s) => s.script);
  const setScript = useCreateStore((s) => s.setScript);
  const setSelection = useCreateStore((s) => s.setSelection);
  const hasProject = useCreateStore((s) => s.projectId != null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    registerEditor(ref.current);
    return () => registerEditor(null);
  }, []);

  const reportSelection = useCallback(
    (e: SyntheticEvent<HTMLTextAreaElement>) => {
      const el = e.currentTarget;
      setSelection({ start: el.selectionStart, end: el.selectionEnd });
    },
    [setSelection],
  );

  return (
    <Textarea
      ref={ref}
      id="script-editor"
      aria-label="Script"
      hint={hasProject ? "Blank lines separate paragraphs. Select text and use “Regenerate selection” to redo only those segments." : "Choose or create a project to start writing."}
      rows={16}
      value={script}
      disabled={!hasProject}
      spellCheck
      placeholder="Type or import the text you want spoken…"
      onChange={(e) => setScript(e.target.value)}
      onSelect={reportSelection}
      onKeyUp={reportSelection}
      onMouseUp={reportSelection}
      onBlur={reportSelection}
      textareaClassName="text-[15px] leading-[1.7] min-h-[26em] font-sans"
    />
  );
}
