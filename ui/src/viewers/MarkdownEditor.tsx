import { useEffect, useMemo, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { CodeMirror } from "../editor/CodeMirror";
import { markdownExtensions } from "../editor/setup";
import { refreshPreview, FRONTMATTER_RE } from "../editor/livePreview";
import type { EditorContext } from "../editor/context";
import { useWorkspace, type Buffer } from "../state/workspace";
import { useVault } from "../state/vault";
import { api, fileUrl, openExternal } from "../ipc/api";
import { resolveLink, linkTextFor } from "../links";
import { droppedItems, embedsFor, importDropped, isFinderDrag, newFileOfKind } from "../actions";
import { parentOf } from "../state/vault";
import { useUi } from "../state/ui";

/** Files above this size open read-only so the UI stays responsive. */
export const LARGE_FILE_BYTES = 5 * 1024 * 1024;

export function editorContextFor(path: string): EditorContext {
  const entries = () => useVault.getState().entries;
  const resolve = (target: string, markdown = false) => resolveLink(target, entries(), path, useVault.getState().aliases, markdown);
  return {
    path,
    resolve,
    async openLink(target, newTab) {
      const resolved = resolve(target.split("#")[0].split("^")[0]);
      if (resolved) {
        await useWorkspace.getState().open(resolved, { newTab });
        return;
      }
      const name = target.split(/[#^|]/)[0].trim();
      if (!name) return;
      const created = await newFileOfKind("", name, /\.[a-z0-9]+$/i.test(name) ? "" : "md", "");
      if (!created) useVault.getState().setError(`Couldn't create “${name}”.`);
    },
    openExternal: (url) => void openExternal(url),
    openTag: (tag) => useUi.getState().showSearch(`tag:${tag}`),
    fileUrl,
    readText: async (p) => (await api.read(p)).content ?? "",
    importDrop(dt) {
      if (!isFinderDrag(dt)) return null;
      return importDropped(droppedItems(dt), parentOf(path)).then((paths) => {
        const dirs = new Set(entries().filter((e) => e.is_dir).map((e) => e.path));
        return embedsFor(paths.filter((p) => !dirs.has(p)));
      });
    },
    async openAsDiagram(source) {
      try {
        const { mermaidToCanvas } = await import("../diagrams/mermaidToCanvas");
        const { serializeCanvas } = await import("./canvas/jsonCanvas");
        const doc = await mermaidToCanvas(source);
        const stem = `${path.split("/").pop()!.replace(/\.md$/i, "")} diagram`;
        await newFileOfKind(parentOf(path), stem, "canvas", serializeCanvas(doc));
      } catch (e) {
        useVault.getState().setError(`Couldn't open the diagram: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    linkCandidates: () => {
      const all = entries();
      const files = all
        .filter((e) => !e.is_dir && e.path !== path)
        .map((e) => ({ label: linkTextFor(e.path, all, path), detail: e.path.includes("/") ? e.path : "" }));
      const aliases = useVault.getState().aliases.map(([alias, p]) => ({
        label: alias,
        detail: `alias of ${p}`,
        insert: `${linkTextFor(p, all, path)}|${alias}`,
      }));
      return [...files, ...aliases];
    },
  };
}

export function MarkdownEditor({ buffer }: { buffer: Buffer }) {
  const path = buffer.path;
  const readOnly = (buffer.content?.length ?? 0) > LARGE_FILE_BYTES;
  const view = useRef<EditorView | null>(null);
  const extensions = useMemo(
    () => markdownExtensions(editorContextFor(path), (text) => useWorkspace.getState().edit(path, text), readOnly),
    [path, readOnly],
  );

  // Re-render link states when files appear, disappear or move.
  const entries = useVault((s) => s.entries);
  useEffect(() => {
    view.current?.dispatch({ effects: refreshPreview.of(null) });
  }, [entries]);

  return (
    <div className="md-scroll">
      {readOnly && <div className="notice warn"><span>This file is larger than 5 MB and opened read-only.</span></div>}
      <CodeMirror
        className="md-editor"
        doc={buffer.content ?? ""}
        version={buffer.version}
        extensions={extensions}
        onView={(v) => {
          view.current = v;
          // Start below the properties block so it opens rendered, like Obsidian.
          const fm = v && FRONTMATTER_RE.exec(v.state.doc.toString());
          if (v && fm) v.dispatch({ selection: { anchor: Math.min(fm[0].length + 1, v.state.doc.length) } });
        }}
        autoFocus
      />
    </div>
  );
}
