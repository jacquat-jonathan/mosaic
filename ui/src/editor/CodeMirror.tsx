import { useEffect, useRef } from "react";
import { EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { textChanges } from "./textDiff";
import { rememberTableFocus, restoreTableFocus } from "./TableWidget";

/**
 * Applies a new version of the note from outside (an agent, a sync) as the smallest set of changes,
 * so the caret, selection, scroll position and open widgets map through it. The reload isn't an undo
 * step; the user's own edits stay undoable and are mapped past it.
 */
export function applyReload(view: EditorView, doc: string) {
  const current = view.state.doc.toString();
  if (current === doc) return;
  const changes = view.state.changes(textChanges(current, doc));
  const focus = rememberTableFocus(view);
  view.dispatch({
    changes,
    annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
  });
  if (focus) restoreTableFocus(view, focus, changes);
}

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
    if (v) applyReload(v, doc);
  }, [version]);

  return <div ref={host} className={className} />;
}
