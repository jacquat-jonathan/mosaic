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

  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is created once per set of extensions; later documents arrive through the next effect
  useEffect(() => {
    const v = new EditorView({ parent: host.current!, state: EditorState.create({ doc, extensions }) });
    view.current = v;
    onView?.(v);
    if (autoFocus) v.focus();
    return () => {
      onView?.(null);
      v.destroy();
    };
  }, [extensions]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new version from outside replaces the document; typing changes `doc` too
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === doc) return;
    const head = Math.min(v.state.selection.main.head, doc.length);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: doc }, selection: { anchor: head } });
  }, [version]);

  return <div ref={host} className={className} />;
}
