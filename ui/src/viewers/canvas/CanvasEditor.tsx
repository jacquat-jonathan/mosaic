import { createPortal } from "react-dom";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  NodeResizer,
  MarkerType,
  ConnectionMode,
  useReactFlow,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ExternalLink, FileText, Maximize, Plus, SquareDashed } from "lucide-react";
import { useWorkspace, type Buffer } from "../../state/workspace";
import { parentOf, useVault } from "../../state/vault";
import { droppedItems, importDropped, isFinderDrag } from "../../actions";
import { useUi, type MenuItem } from "../../state/ui";
import { api, fileUrl, openExternal } from "../../ipc/api";
import { kindOf } from "../../ipc/kinds";
import { resolveLink } from "../../links";
import { renderMarkdown } from "../../markdown";
import { CodeEditor } from "../CodeEditor";
import { Segmented, Toolbar } from "../Toolbar";
import {
  CanvasParseError,
  KNOWN_NODE_TYPES,
  PRESET_COLORS,
  colorOf,
  newId,
  parseCanvas,
  serializeCanvas,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
  type Side,
} from "./jsonCanvas";
import { useDark } from "../../theme";

const TREE_DRAG = "application/x-mosaic-path";
const DEFAULT_EDGE_COLOR = "#8a8f9c";
const SIDES: Side[] = ["top", "right", "bottom", "left"];
const POS: Record<Side, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };

type CardData = { node: CanvasNode; canvasPath: string; onText(id: string, text: string): void };
type FlowNode = Node<CardData>;

function bestSides(a: CanvasNode, b: CanvasNode): [Side, Side] {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? ["right", "left"] : ["left", "right"];
  return dy > 0 ? ["bottom", "top"] : ["top", "bottom"];
}

function toFlowEdge(e: CanvasEdge, byId: Map<string, CanvasNode>): Edge {
  const from = byId.get(e.fromNode);
  const to = byId.get(e.toNode);
  const [fs, ts] = from && to ? bestSides(from, to) : (["right", "left"] as [Side, Side]);
  const color = colorOf(e.color) ?? DEFAULT_EDGE_COLOR;
  const arrow = (c: string) => ({ type: MarkerType.ArrowClosed, width: 18, height: 18, color: c });
  return {
    id: e.id,
    source: e.fromNode,
    target: e.toNode,
    sourceHandle: e.fromSide ?? fs,
    targetHandle: e.toSide ?? ts,
    label: e.label,
    markerEnd: (e.toEnd ?? "arrow") === "arrow" ? arrow(color) : undefined,
    markerStart: e.fromEnd === "arrow" ? arrow(color) : undefined,
    style: { stroke: color, strokeWidth: 2 },
    data: { edge: e },
  };
}

function toFlow(doc: CanvasDoc, canvasPath: string, onText: CardData["onText"]): { nodes: FlowNode[]; edges: Edge[] } {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  // Groups first so they render beneath their contents.
  const ordered = [...doc.nodes.filter((n) => n.type === "group"), ...doc.nodes.filter((n) => n.type !== "group")];
  return {
    nodes: ordered.map((n) => ({
      id: n.id,
      type: n.type === "group" ? "group-card" : "card",
      position: { x: n.x, y: n.y },
      width: n.width,
      height: n.height,
      zIndex: n.type === "group" ? -1 : 0,
      data: { node: n, canvasPath, onText },
    })),
    edges: doc.edges.filter((e) => byId.has(e.fromNode) && byId.has(e.toNode)).map((e) => toFlowEdge(e, byId)),
  };
}

export function CanvasEditor({ buffer }: { buffer: Buffer }) {
  const [mode, setMode] = useState<"canvas" | "source">("canvas");
  const [toolsHost, setToolsHost] = useState<HTMLElement | null>(null);
  const parsed = useMemo(() => {
    try {
      return { doc: parseCanvas(buffer.content ?? ""), error: null };
    } catch (e) {
      return { doc: null, error: e instanceof CanvasParseError ? e.message : String(e) };
    }
    // Re-parse only on external reloads; our own edits already live in the flow state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer.version, buffer.path]);

  const showSource = mode === "source" || !parsed.doc;
  return (
    <div className="viewer">
      <Toolbar>
        <Segmented<"canvas" | "source"> value={showSource ? "source" : "canvas"} onChange={setMode} options={[{ value: "canvas", label: "Canvas" }, { value: "source", label: "Source" }]} />
        {parsed.error && <span className="toolbar-error">Can't display this canvas: {parsed.error}. The file is left untouched — fix it in Source.</span>}
        <span className="spacer" />
        <span ref={setToolsHost} />
      </Toolbar>
      {showSource ? (
        <CodeEditor buffer={buffer} />
      ) : (
        <ReactFlowProvider>
          <CanvasFlow key={buffer.version} path={buffer.path} doc={parsed.doc!} toolsHost={toolsHost} />
        </ReactFlowProvider>
      )}
    </div>
  );
}

function CanvasFlow({ path, doc: initial, toolsHost }: { path: string; doc: CanvasDoc; toolsHost: HTMLElement | null }) {
  const flow = useReactFlow<FlowNode, Edge>();
  const docRef = useRef<CanvasDoc>(initial);
  const onText = useCallback((id: string, text: string) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, node: { ...n.data.node, text } } } : n)));
    queueMicrotask(() => commitRef.current());
  }, []);
  const start = useMemo(() => toFlow(initial, path, onText), [initial, path, onText]);
  const [nodes, setNodes] = useState<FlowNode[]>(start.nodes);
  const [edges, setEdges] = useState<Edge[]>(start.edges);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const dark = useDark();

  /** Writes the current flow back to JSON Canvas, keeping unknown fields of existing items. */
  const commit = useCallback(() => {
    const prev = docRef.current;
    const prevNodes = new Map(prev.nodes.map((n) => [n.id, n]));
    const prevEdges = new Map(prev.edges.map((e) => [e.id, e]));
    const outNodes: CanvasNode[] = [];
    // Keep the original order for existing nodes, then append new ones.
    const flowById = new Map(nodesRef.current.map((n) => [n.id, n]));
    const ids = [...prev.nodes.map((n) => n.id).filter((id) => flowById.has(id)), ...nodesRef.current.map((n) => n.id).filter((id) => !prevNodes.has(id))];
    for (const id of ids) {
      const f = flowById.get(id)!;
      const base = { ...(prevNodes.get(id) ?? {}), ...f.data.node };
      outNodes.push({
        ...base,
        x: Math.round(f.position.x),
        y: Math.round(f.position.y),
        width: Math.round(f.measured?.width ?? f.width ?? base.width),
        height: Math.round(f.measured?.height ?? f.height ?? base.height),
      });
    }
    const outEdges: CanvasEdge[] = edgesRef.current.map((e) => {
      const orig = (e.data?.edge as CanvasEdge | undefined) ?? prevEdges.get(e.id);
      const out: CanvasEdge = { ...(orig ?? {}), id: e.id, fromNode: e.source, toNode: e.target };
      if (orig?.fromSide || e.sourceHandle !== orig?.fromSide) out.fromSide = (e.sourceHandle as Side) ?? undefined;
      if (orig?.toSide || e.targetHandle !== orig?.toSide) out.toSide = (e.targetHandle as Side) ?? undefined;
      if (typeof e.label === "string" && e.label) out.label = e.label;
      else delete out.label;
      return out;
    });
    const next: CanvasDoc = { ...prev, nodes: outNodes, edges: outEdges };
    docRef.current = next;
    useWorkspace.getState().edit(path, serializeCanvas(next));
  }, [path]);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  // Dragging a group carries the cards inside it, like Obsidian.
  const groupDrag = useRef<{ id: string; start: { x: number; y: number }; members: Map<string, { x: number; y: number }> } | null>(null);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      setNodes((ns) => {
        let next = applyNodeChanges(changes, ns);
        const g = groupDrag.current;
        if (g) {
          const group = next.find((n) => n.id === g.id);
          if (group) {
            const dx = group.position.x - g.start.x;
            const dy = group.position.y - g.start.y;
            next = next.map((n) => {
              const p = g.members.get(n.id);
              return p ? { ...n, position: { x: p.x + dx, y: p.y + dy } } : n;
            });
          }
        }
        return next;
      });
      const done = changes.some(
        (c) => c.type === "remove" || (c.type === "position" && c.dragging === false) || (c.type === "dimensions" && c.resizing === false),
      );
      if (done) {
        if (changes.some((c) => c.type === "remove")) {
          const removed = new Set(changes.filter((c) => c.type === "remove").map((c) => c.id));
          setEdges((es) => es.filter((e) => !removed.has(e.source) && !removed.has(e.target)));
        }
        queueMicrotask(() => commitRef.current());
      }
    },
    [],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((es) => applyEdgeChanges(changes, es));
    if (changes.some((c) => c.type === "remove")) queueMicrotask(() => commitRef.current());
  }, []);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    const edge: CanvasEdge = { id: newId(), fromNode: c.source, toNode: c.target, fromSide: (c.sourceHandle as Side) ?? undefined, toSide: (c.targetHandle as Side) ?? undefined };
    const byId = new Map(nodesRef.current.map((n) => [n.id, n.data.node]));
    setEdges((es) => [...es, toFlowEdge(edge, byId)]);
    queueMicrotask(() => commitRef.current());
  }, []);

  const addNode = useCallback(
    (partial: Partial<CanvasNode> & Pick<CanvasNode, "type">, at?: { x: number; y: number }) => {
      const center = at ?? flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      const width = partial.width ?? (partial.type === "group" ? 560 : 260);
      const height = partial.height ?? (partial.type === "group" ? 380 : partial.type === "file" ? 300 : 120);
      const node: CanvasNode = { id: newId(), x: Math.round(center.x - width / 2), y: Math.round(center.y - height / 2), width, height, ...partial };
      const fn: FlowNode = {
        id: node.id,
        type: node.type === "group" ? "group-card" : "card",
        position: { x: node.x, y: node.y },
        width,
        height,
        zIndex: node.type === "group" ? -1 : 0,
        selected: true,
        data: { node, canvasPath: path, onText },
      };
      // Updated by hand too: when called outside a React event (e.g. after an async import), the
      // commit below would otherwise run before the re-render and save the old nodes.
      nodesRef.current = [...nodesRef.current.map((n) => ({ ...n, selected: false })), fn];
      setNodes(nodesRef.current);
      queueMicrotask(() => commitRef.current());
      return node.id;
    },
    [flow, path, onText],
  );

  const setNodeField = (id: string, patch: Partial<CanvasNode>) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, node: { ...n.data.node, ...patch } } } : n)));
    queueMicrotask(() => commitRef.current());
  };

  const colorItems = (apply: (c: string | undefined) => void): MenuItem[] => [
    { label: "No colour", action: () => apply(undefined) },
    ...Object.keys(PRESET_COLORS).map((k) => ({ label: `● ${["Red", "Orange", "Yellow", "Green", "Cyan", "Purple"][Number(k) - 1]}`, action: () => apply(k) })),
  ];

  const onNodeContextMenu = (e: ReactMouseEvent, n: FlowNode) => {
    e.preventDefault();
    const node = n.data.node;
    const items: MenuItem[] = [];
    if (node.type === "file" && node.file) items.push({ label: "Open file", action: () => void useWorkspace.getState().open(node.file!, { newTab: true }) });
    if (node.type === "link" && node.url) items.push({ label: "Open link in browser", action: () => void openExternal(node.url!) });
    if (node.type === "group")
      items.push({
        label: "Rename group",
        action: async () => {
          const label = await useUi.getState().askText({ title: "Group label", value: node.label ?? "" });
          if (label !== null) setNodeField(node.id, { label });
        },
      });
    items.push(...colorItems((c) => setNodeField(node.id, { color: c })), { label: "", separator: true });
    items.push({ label: "Delete", danger: true, action: () => onNodesChange([{ type: "remove", id: node.id }]) });
    useUi.getState().showMenu(e.clientX, e.clientY, items);
  };

  const onEdgeContextMenu = (e: ReactMouseEvent, edge: Edge) => {
    e.preventDefault();
    const setEdgeField = (patch: Partial<CanvasEdge>) => {
      setEdges((es) =>
        es.map((x) => {
          if (x.id !== edge.id) return x;
          const orig = { ...((x.data?.edge as CanvasEdge) ?? {}), ...patch } as CanvasEdge;
          const byId = new Map(nodesRef.current.map((n) => [n.id, n.data.node]));
          return { ...toFlowEdge(orig, byId), sourceHandle: x.sourceHandle, targetHandle: x.targetHandle };
        }),
      );
      queueMicrotask(() => commitRef.current());
    };
    useUi.getState().showMenu(e.clientX, e.clientY, [
      {
        label: "Edit label",
        action: async () => {
          const label = await useUi.getState().askText({ title: "Connection label", value: typeof edge.label === "string" ? edge.label : "" });
          if (label !== null) setEdgeField({ label: label || undefined });
        },
      },
      ...colorItems((c) => setEdgeField({ color: c })),
      { label: "", separator: true },
      { label: "Delete connection", danger: true, action: () => onEdgesChange([{ type: "remove", id: edge.id }]) },
    ]);
  };

  const onDrop = (e: DragEvent) => {
    if (isFinderDrag(e.dataTransfer)) {
      // Copied next to the canvas, then one file card each, fanned out from the drop point.
      e.preventDefault();
      const pos = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      void importDropped(droppedItems(e.dataTransfer), parentOf(path)).then((paths) => {
        const dirs = new Set(useVault.getState().entries.filter((x) => x.is_dir).map((x) => x.path));
        paths.filter((p) => !dirs.has(p)).forEach((p, i) => addNode({ type: "file", file: p }, { x: pos.x + i * 40, y: pos.y + i * 40 }));
      });
      return;
    }
    const p = e.dataTransfer.getData(TREE_DRAG);
    if (!p) return;
    e.preventDefault();
    const pos = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    if (p.toLowerCase().endsWith(".canvas") && p === path) return;
    addNode({ type: "file", file: p }, pos);
  };

  const addFile = async () => {
    const p = await useUi.getState().askText({ title: "Add a file card", value: "", placeholder: "Vault path or note name, e.g. Projects/Plan" });
    if (!p) return;
    const resolved = resolveLink(p, useVault.getState().entries, path) ?? p;
    addNode({ type: "file", file: resolved });
  };

  const tools = toolsHost;
  return (
    <div
      className="canvas-host"
      onDragOver={(e) => (e.dataTransfer.types.includes(TREE_DRAG) || isFinderDrag(e.dataTransfer)) && e.preventDefault()}
      onDrop={onDrop}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).classList.contains("react-flow__pane")) addNode({ type: "text", text: "" }, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
    >
      {tools && (
        <CanvasTools
          onCard={() => addNode({ type: "text", text: "" })}
          onGroup={() => addNode({ type: "group", label: "Group" })}
          onFile={() => void addFile()}
          onFit={() => void flow.fitView({ padding: 0.2, duration: 200 })}
          host={tools}
        />
      )}
      <ReactFlow<FlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={(_e, n) => {
          if (n.data.node.type !== "group") return;
          const g = n.data.node;
          const x0 = n.position.x;
          const y0 = n.position.y;
          const w = n.measured?.width ?? g.width;
          const h = n.measured?.height ?? g.height;
          const members = new Map<string, { x: number; y: number }>();
          for (const m of nodesRef.current) {
            if (m.id === n.id) continue;
            const mw = m.measured?.width ?? m.data.node.width;
            const mh = m.measured?.height ?? m.data.node.height;
            if (m.position.x >= x0 && m.position.y >= y0 && m.position.x + mw <= x0 + w && m.position.y + mh <= y0 + h) members.set(m.id, { ...m.position });
          }
          groupDrag.current = { id: n.id, start: { ...n.position }, members };
        }}
        onNodeDragStop={() => (groupDrag.current = null)}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        connectionMode={ConnectionMode.Loose}
        zoomOnDoubleClick={false}
        deleteKeyCode={["Backspace", "Delete"]}
        colorMode={dark ? "dark" : "light"}
        minZoom={0.1}
        maxZoom={4}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}

function CanvasTools({ onCard, onGroup, onFile, onFit, host }: { onCard(): void; onGroup(): void; onFile(): void; onFit(): void; host: HTMLElement }) {
  return createPortal(
    <span className="canvas-tools">
      <button onClick={onCard} title="Add a text card (or double-click the canvas)"><Plus size={14} /> Card</button>
      <button onClick={onFile} title="Add a note or file (or drag one from the sidebar)"><FileText size={14} /> File</button>
      <button onClick={onGroup}><SquareDashed size={14} /> Group</button>
      <button onClick={onFit} title="Fit to view"><Maximize size={14} /></button>
    </span>,
    host,
  );
}

function Handles() {
  return (
    <>
      {SIDES.map((s) => (
        <Handle key={s} id={s} type="source" position={POS[s]} className="canvas-handle" />
      ))}
    </>
  );
}

const Card = memo(function Card({ data, selected }: NodeProps<FlowNode>) {
  const n = data.node;
  const color = colorOf(n.color);
  return (
    <div className={`canvas-card ${selected ? "selected" : ""}`} style={color ? { borderColor: color, ["--card-tint" as string]: color } : undefined}>
      <NodeResizer isVisible={selected} minWidth={120} minHeight={60} lineClassName="canvas-resize-line" handleClassName="canvas-resize-handle" />
      <Handles />
      {n.type === "text" && <TextCard id={n.id} text={n.text ?? ""} onText={data.onText} canvasPath={data.canvasPath} />}
      {n.type === "file" && <FileCard file={n.file ?? ""} subpath={n.subpath} />}
      {n.type === "link" && <LinkCard url={n.url ?? ""} />}
      {!KNOWN_NODE_TYPES.includes(n.type) && (
        <div className="canvas-unknown" title="Mosaic can't show this card yet. It is kept as is when the canvas is saved.">
          Unsupported card type “{n.type}”
        </div>
      )}
    </div>
  );
});

const GroupCard = memo(function GroupCard({ data, selected }: NodeProps<FlowNode>) {
  const n = data.node;
  const color = colorOf(n.color);
  return (
    <div className={`canvas-group ${selected ? "selected" : ""}`} style={color ? { borderColor: color, background: `${color}14` } : undefined}>
      <NodeResizer isVisible={selected} minWidth={160} minHeight={100} lineClassName="canvas-resize-line" handleClassName="canvas-resize-handle" />
      <Handles />
      {n.label && <div className="canvas-group-label" style={color ? { color } : undefined}>{n.label}</div>}
    </div>
  );
});

const NODE_TYPES = { card: Card, "group-card": GroupCard };

function useLinkClicks(canvasPath: string) {
  return (e: ReactMouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-target], a[href]");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    if (el.dataset.target !== undefined) {
      const resolved = resolveLink(el.dataset.target, useVault.getState().entries, canvasPath);
      if (resolved) void useWorkspace.getState().open(resolved, { newTab: e.metaKey });
    } else {
      const href = el.getAttribute("href") ?? "";
      if (/^(https?|mailto):/.test(href)) void openExternal(href);
    }
  };
}

function TextCard({ id, text, onText, canvasPath }: { id: string; text: string; onText(id: string, t: string): void; canvasPath: string }) {
  const [editing, setEditing] = useState(text === "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const entries = useVault((s) => s.entries);
  const html = useMemo(() => renderMarkdown(text, (t) => resolveLink(t, entries, canvasPath)), [text, entries, canvasPath]);
  const onClick = useLinkClicks(canvasPath);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  if (editing) {
    return (
      <textarea
        ref={ref}
        className="canvas-text-edit nodrag nowheel"
        defaultValue={text}
        placeholder="Write Markdown…"
        onBlur={(e) => {
          setEditing(false);
          if (e.target.value !== text) onText(id, e.target.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
        }}
      />
    );
  }
  return (
    <div className="canvas-text md-render nowheel" onDoubleClick={() => setEditing(true)} onClick={onClick}>
      {text ? <div dangerouslySetInnerHTML={{ __html: html }} /> : <span className="canvas-placeholder">Double-click to write</span>}
    </div>
  );
}

function FileCard({ file, subpath }: { file: string; subpath?: string }) {
  const kind = kindOf(file);
  const exists = useVault((s) => s.entries.some((e) => e.path === file));
  const revision = useVault((s) => s.revision);
  const [preview, setPreview] = useState<{ html?: string; img?: string } | null>(null);
  useEffect(() => {
    let live = true;
    if (!exists) return;
    if (kind === "image") void fileUrl(file).then((img) => live && setPreview({ img }));
    else if (kind === "markdown") void api.read(file).then((f) => live && setPreview({ html: renderMarkdown((f.content ?? "").replace(/^---\n[\s\S]*?\n---\n?/, "").slice(0, 4000)) }));
    return () => {
      live = false;
    };
  }, [file, kind, exists, revision]);
  const name = file.split("/").pop()!.replace(/\.md$/, "");
  return (
    <div className="canvas-file">
      <button className="canvas-file-title nodrag" onClick={(e) => void useWorkspace.getState().open(file, { newTab: e.metaKey })} title={file}>
        {name}
        {subpath ? ` ${subpath}` : ""}
      </button>
      <div className="canvas-file-body nowheel">
        {!exists && <span className="canvas-placeholder">File not found: {file}</span>}
        {preview?.img && <img src={preview.img} alt={file} />}
        {preview?.html && <div className="md-render" dangerouslySetInnerHTML={{ __html: preview.html }} />}
        {exists && !preview && kind !== "image" && kind !== "markdown" && <span className="canvas-placeholder">{kind} file</span>}
      </div>
    </div>
  );
}

function LinkCard({ url }: { url: string }) {
  return (
    <div className="canvas-link">
      <ExternalLink size={16} />
      <button className="nodrag" onClick={() => void openExternal(url)} title="Open in browser">
        {url}
      </button>
    </div>
  );
}
