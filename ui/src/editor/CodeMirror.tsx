import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Hosts one CodeMirror view. `doc` is only applied when `version` changes (a reload from disk), so
 * typing never round-trips through React.
 */
export function CodeMirror({
  doc,
  version,
  extensions,
  className,
  autoFocus,
  onView,
}: {
  doc: string;
  version: number;
  extensions: Extension;
  className?: string;
  autoFocus?: boolean;
  onView?: (view: EditorView | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  useEffect(() => {
    const v = new EditorView({ parent: host.current!, state: EditorState.create({ doc, extensions }) });
    view.current = v;
    onView?.(v);
    if (autoFocus) v.focus();
    return () => {
      onView?.(null);
      v.destroy();
    };
    // Recreated only when the extensions change (e.g. a different file kind).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensions]);

  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === doc) return;
    const head = Math.min(v.state.selection.main.head, doc.length);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: doc }, selection: { anchor: head } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  return <div ref={host} className={className} />;
}
