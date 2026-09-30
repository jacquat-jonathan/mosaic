// User-level actions that touch both the vault tree and open tabs.

import { useUi } from "./state/ui";
import { baseName, parentOf, useVault } from "./state/vault";
import { useWorkspace } from "./state/workspace";
import { kindOf } from "./ipc/kinds";
import { displayName } from "./views/FileTree";

export async function newNote(dir: string) {
  const path = await useVault.getState().newFile(dir, "Untitled", "md");
  if (!path) return;
  await useWorkspace.getState().open(path, { newTab: true });
  useVault.getState().setRenaming(path);
}

export async function newFileOfKind(dir: string, stem: string, ext: string, content: string) {
  const path = await useVault.getState().newFile(dir, stem, ext, content);
  if (path) await useWorkspace.getState().open(path, { newTab: true });
  return path;
}

export async function renamePath(from: string, to: string) {
  const out = await useVault.getState().rename(from, to);
  if (out) useWorkspace.getState().renamed(from, out);
  return out;
}

export async function moveInto(path: string, dir: string) {
  if (parentOf(path) === dir || dir === path || dir.startsWith(`${path}/`)) return;
  await renamePath(path, dir ? `${dir}/${baseName(path)}` : baseName(path));
}

export async function deletePath(path: string, isDir: boolean) {
  const ws = useWorkspace.getState();
  const dirty = Object.values(ws.buffers).some(
    (b) => b.dirty && (b.path === path || b.path.startsWith(`${path}/`)),
  );
  const ok = await useUi.getState().ask({
    title: `Move “${isDir ? baseName(path) : displayName({ name: baseName(path), kind: kindOf(path) })}” to the Trash?`,
    body:
      (isDir ? "The folder and everything in it will be moved to the macOS Trash." : "The file will be moved to the macOS Trash.") +
      (dirty ? " It has unsaved changes, which will be lost." : " You can restore it from there."),
    confirmLabel: "Move to Trash",
    danger: true,
  });
  if (!ok) return;
  if (await useVault.getState().remove(path)) {
    for (const b of Object.values(useWorkspace.getState().buffers)) {
      if (b.path === path || b.path.startsWith(`${path}/`)) useWorkspace.setState((s) => ({ buffers: { ...s.buffers, [b.path]: { ...b, dirty: false } } }));
    }
    ws.deleted(path);
  }
}

const CHART_TEMPLATE = JSON.stringify(
  {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    description: "Edit the data or point data.url at a CSV/JSON file in the vault.",
    data: { values: [ { item: "A", value: 28 }, { item: "B", value: 55 }, { item: "C", value: 43 } ] },
    mark: "bar",
    encoding: { x: { field: "item", type: "nominal" }, y: { field: "value", type: "quantitative" } },
  },
  null,
  2,
);

const GRAPH_TEMPLATE = `digraph G {
  rankdir=LR;
  node [shape=box, style=rounded];
  Idea -> Draft -> Review -> Published;
  Review -> Draft [label="changes"];
}
`;

/** "New …" commands for every kind of file Mosaic can create. */
export const NEW_KINDS = [
  { label: "New note", stem: "Untitled", ext: "md", content: "" },
  { label: "New canvas", stem: "Untitled", ext: "canvas", content: '{\n\t"nodes":[],\n\t"edges":[]\n}' },
  { label: "New drawing", stem: "Drawing", ext: "excalidraw", content: "" },
  { label: "New chart", stem: "Chart", ext: "vl.json", content: CHART_TEMPLATE },
  { label: "New graph (Graphviz)", stem: "Graph", ext: "dot", content: GRAPH_TEMPLATE },
] as const;

export async function newOfKind(dir: string, kind: (typeof NEW_KINDS)[number]) {
  if (kind.ext === "md") return newNote(dir);
  const { EMPTY_DRAWING } = await import("./viewers/ExcalidrawEditor");
  const path = await newFileOfKind(dir, kind.stem, kind.ext, kind.ext === "excalidraw" ? EMPTY_DRAWING : kind.content);
  if (path) useVault.getState().setRenaming(path);
}
