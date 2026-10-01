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
  ConnectionMode,
  ViewportPortal,
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
import { Ellipsis, ExternalLink, FileText, Maximize, Network, Plus, Shapes, SquareDashed } from "lucide-react";
import { useWorkspace, type Buffer } from "../../state/workspace";
import { parentOf, useVault } from "../../state/vault";
import { droppedItems, importDropped, isFinderDrag } from "../../actions";
import { useUi, type MenuItem } from "../../state/ui";
import { api, fileUrl, openExternal } from "../../ipc/api";
import { kindOf } from "../../ipc/kinds";
import { resolveLink } from "../../links";
import { renderMarkdown } from "../../markdown";
import { renderBlocksIn } from "../../editor/blocks";
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
import {
  BACKGROUND,
  BORDERS,
  ENDS,
  EdgeMarkers,
  LABELLESS,
  LINES,
  SHAPES,
  SHAPE_GROUPS,
  ShapeOutline,
  cssShape,
  isShape,
  type EndName,
  type ShapeName,
} from "../../diagrams/shapes";
import { DiagramEdge, edgeEnds, type DiagramEdgeData } from "./DiagramEdge";
import { align } from "./align";
import { autoLayout } from "./layout";
import { canvasToMermaid } from "../../diagrams/canvasToMermaid";
import { exportCanvas } from "../../diagrams/export";
import { plainLines } from "../../diagrams/canvasToSvg";
import { errorMessage } from "../../ipc/types";

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

/**
 * Connection points along each side, as fractions of its length. Lifelines and frames get many, so
 * sequence messages can leave and arrive at any height. Stored as `fromOffset` / `toOffset` when the
 * point isn't the middle of the side.
 */
function portsOf(n: CanvasNode | undefined): number[] {
  return n?.shape === "lifeline" || n?.shape === "frame" ? [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] : [0.25, 0.5, 0.75];
}

const handleId = (side: Side, offset: number) => (offset === 0.5 ? side : `${side}:${offset}`);

function parseHandle(id: string | null | undefined): { side: Side; offset: number } | null {
  if (!id) return null;
  const [side, offset] = id.split(":");
  return SIDES.includes(side as Side) ? { side: side as Side, offset: offset ? Number(offset) : 0.5 } : null;
}

/** The handle for a stored side and offset, snapped to the nearest point the card has. */
function handleFor(n: CanvasNode | undefined, side: Side, offset: unknown): string {
  const want = typeof offset === "number" ? offset : 0.5;
  const nearest = portsOf(n).reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
  return handleId(side, nearest);
}

function toFlowEdge(e: CanvasEdge, byId: Map<string, CanvasNode>): Edge {
  const from = byId.get(e.fromNode);
  const to = byId.get(e.toNode);
  const [fs, ts] = from && to ? bestSides(from, to) : (["right", "left"] as [Side, Side]);
  const data: DiagramEdgeData = { edge: e, color: colorOf(e.color) ?? DEFAULT_EDGE_COLOR };
  return {
    id: e.id,
    type: "diagram",
    source: e.fromNode,
    target: e.toNode,
    sourceHandle: handleFor(from, e.fromSide ?? fs, e.fromOffset),
    targetHandle: handleFor(to, e.toSide ?? ts, e.toOffset),
    label: e.label,
    data,
  };
}

const EDGE_TYPES = { diagram: DiagramEdge };

/** Sets an optional field, removing it when the value is the default, so files stay minimal. */
function withField<T extends object>(item: T, key: string, value: unknown, fallback?: unknown): T {
  const out = { ...item } as Record<string, unknown>;
  if (value === undefined || value === fallback) delete out[key];
  else out[key] = value;
  return out as T;
}

function toFlow(doc: CanvasDoc, canvasPath: string, onText: CardData["onText"]): { nodes: FlowNode[]; edges: Edge[] } {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  // Groups and frames first so they render beneath their contents.
  const behind = (n: CanvasNode) => n.type === "group" || (isShape(n.shape) && BACKGROUND.has(n.shape));
  const ordered = [...doc.nodes.filter(behind), ...doc.nodes.filter((n) => !behind(n))];
  return {
    nodes: ordered.map((n) => ({
      id: n.id,
      type: n.type === "group" ? "group-card" : "card",
      position: { x: n.x, y: n.y },
      width: n.width,
      height: n.height,
      zIndex: behind(n) ? -1 : 0,
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

  // Presenting: full window, stepping through groups and frames; connections keep flowing.
  const [presenting, setPresenting] = useState<{ steps: { x: number; y: number; width: number; height: number; label: string }[]; index: number } | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  // Hovering a card animates its connections in their direction of travel and dims the rest.
  const [hovered, setHovered] = useState<string | null>(null);
  const shown = useMemo(() => {
    if (presenting) return { nodes, edges: edges.map((e) => ({ ...e, data: { ...(e.data as DiagramEdgeData), flow: "on" as const } })) };
    if (!hovered) return { nodes, edges };
    const near = new Set([hovered]);
    const flowEdges = edges.map((e) => {
      const on = e.source === hovered || e.target === hovered;
      if (on) near.add(e.source).add(e.target);
      return { ...e, data: { ...(e.data as DiagramEdgeData), flow: on ? "on" : "dim" } };
    });
    // Nothing to follow: leave the canvas as it is.
    if (near.size === 1) return { nodes, edges };
    return { nodes: nodes.map((n) => (near.has(n.id) || n.type === "group-card" ? n : { ...n, className: "node-dim" })), edges: flowEdges };
  }, [hovered, nodes, edges, presenting]);

  const present = () => {
    const sized = nodesRef.current.map((n) => ({ ...n.position, width: n.measured?.width ?? n.data.node.width, height: n.measured?.height ?? n.data.node.height, node: n.data.node }));
    const frames = sized.filter((n) => n.node.type === "group" || n.node.shape === "frame");
    // Reading order: rows top to bottom (cards within 40 px count as one row), then left to right.
    frames.sort((a, b) => (Math.abs(a.y - b.y) < 40 ? a.x - b.x : a.y - b.y));
    const all = sized.length
      ? (() => {
          const x = Math.min(...sized.map((n) => n.x));
          const y = Math.min(...sized.map((n) => n.y));
          return { x, y, width: Math.max(...sized.map((n) => n.x + n.width)) - x, height: Math.max(...sized.map((n) => n.y + n.height)) - y, label: "" };
        })()
      : null;
    const steps = frames.length
      ? frames.map((f) => ({ x: f.x, y: f.y, width: f.width, height: f.height, label: f.node.type === "group" ? (f.node.label ?? "") : plainLines(f.node.text ?? "")[0] ?? "" }))
      : all
        ? [all]
        : [];
    if (!steps.length) return;
    setHovered(null);
    setPresenting({ steps, index: 0 });
    void hostRef.current?.requestFullscreen?.().catch(() => {});
  };

  useEffect(() => {
    if (!presenting) return;
    const step = presenting.steps[presenting.index];
    // Room for the group's label above its box. Fit after the full-window layout has settled, and
    // again whenever the window changes size (entering full screen, resizing).
    // An animated fitBounds gets interrupted by React Flow's re-renders; the move is animated in CSS instead.
    const fit = () => void flow.fitBounds({ ...step, y: step.y - 34, height: step.height + 34 }, { padding: 0.1 });
    const t = setTimeout(fit, 60);
    window.addEventListener("resize", fit);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", fit);
    };
  }, [presenting, flow]);

  useEffect(() => {
    if (!presenting) return;
    const onKey = (e: KeyboardEvent) => {
      const go = (d: number) => setPresenting((p) => (p ? { ...p, index: Math.min(p.steps.length - 1, Math.max(0, p.index + d)) } : p));
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(e.key)) go(1);
      else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) go(-1);
      else if (e.key === "Home") setPresenting((p) => (p ? { ...p, index: 0 } : p));
      else if (e.key === "Escape") setPresenting(null);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    // Leaving full screen with the system's own Esc ends the presentation too.
    const onFullscreen = () => !document.fullscreenElement && setPresenting(null);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("fullscreenchange", onFullscreen);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [presenting !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const markers = useMemo(() => {
    const seen = new Map<string, { end: EndName; color: string }>();
    for (const e of edges) {
      const d = e.data as DiagramEdgeData | undefined;
      if (!d) continue;
      const ends = edgeEnds(d.edge);
      for (const end of [ends.from, ends.to]) if (end !== "none") seen.set(`${end}${d.color}`, { end, color: d.color });
    }
    return [...seen.values()];
  }, [edges]);

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
      for (const [handle, sideKey, offsetKey] of [
        [e.sourceHandle, "fromSide", "fromOffset"],
        [e.targetHandle, "toSide", "toOffset"],
      ] as const) {
        const h = parseHandle(handle);
        if (!h) continue;
        out[sideKey] = h.side;
        if (h.offset === 0.5) delete out[offsetKey];
        else out[offsetKey] = h.offset;
      }
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

  // Alignment guides while one card is dragged (not a group carrying its cards, not a multi-selection).
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const moves = changes.filter((c) => c.type === "position");
      // The drag's last change (dragging: false) carries a position too: snap it as well, or it undoes the snap.
      const drag = moves.length === 1 && moves[0].type === "position" && moves[0].position ? moves[0] : null;
      if (drag && drag.position && !groupDrag.current) {
        const size = (n: FlowNode) => ({ width: n.measured?.width ?? n.data.node.width, height: n.measured?.height ?? n.data.node.height });
        const me = nodesRef.current.find((n) => n.id === drag.id);
        if (me) {
          const others = nodesRef.current.filter((n) => n.id !== drag.id && n.type !== "group-card").map((n) => ({ ...n.position, ...size(n) }));
          const a = align({ ...drag.position, ...size(me) }, others);
          drag.position = { x: a.x, y: a.y };
          setGuides(drag.dragging ? { x: a.guideX, y: a.guideY } : {});
        }
      } else if (moves.length) setGuides({});
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
    const src = parseHandle(c.sourceHandle);
    const tgt = parseHandle(c.targetHandle);
    const edge: CanvasEdge = { id: newId(), fromNode: c.source, toNode: c.target, fromSide: src?.side, toSide: tgt?.side };
    if (src && src.offset !== 0.5) edge.fromOffset = src.offset;
    if (tgt && tgt.offset !== 0.5) edge.toOffset = tgt.offset;
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
        zIndex: node.type === "group" || (isShape(node.shape) && BACKGROUND.has(node.shape)) ? -1 : 0,
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
    if (node.type === "text") {
      const shape = isShape(node.shape) ? node.shape : undefined;
      const setNode = (key: string, value: unknown, fallback?: unknown) => {
        setNodes((ns) => ns.map((x) => (x.id === node.id ? { ...x, data: { ...x.data, node: withField(x.data.node, key, value, fallback) } } : x)));
        queueMicrotask(() => commitRef.current());
      };
      items.push({
        label: "Shape",
        children: [
          { label: "Card (no shape)", checked: !shape, action: () => setNode("shape", undefined) },
          ...SHAPE_GROUPS.map((g) => ({
            label: g,
            children: SHAPES.filter((sh) => sh.group === g).map((sh) => ({ label: sh.label, checked: shape === sh.name, action: () => setNode("shape", sh.name) })),
          })),
        ],
      });
      if (shape)
        items.push({
          label: "Border",
          children: BORDERS.map((b) => ({ label: b[0].toUpperCase() + b.slice(1), checked: (node.border ?? "solid") === b, action: () => setNode("border", b, "solid") })),
        });
    }
    items.push({ label: "Colour", children: colorItems((c) => setNodeField(node.id, { color: c })) }, { label: "", separator: true });
    items.push({ label: "Delete", danger: true, action: () => onNodesChange([{ type: "remove", id: node.id }]) });
    useUi.getState().showMenu(e.clientX, e.clientY, items);
  };

  const onEdgeContextMenu = (e: ReactMouseEvent, edge: Edge) => {
    e.preventDefault();
    const current = (edge.data?.edge as CanvasEdge | undefined) ?? ({} as CanvasEdge);
    const ends = edgeEnds(current);
    const setEdgeField = (patch: Partial<CanvasEdge>, fallback?: Record<string, unknown>) => {
      setEdges((es) =>
        es.map((x) => {
          if (x.id !== edge.id) return x;
          let orig = { ...((x.data?.edge as CanvasEdge) ?? {}) } as CanvasEdge;
          for (const [k, v] of Object.entries(patch)) orig = withField(orig, k, v, fallback?.[k]);
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
      {
        label: "Labels at the ends…",
        action: async () => {
          const fromLabel = await useUi.getState().askText({ title: "Label at the start (e.g. 1)", value: current.fromLabel ?? "" });
          if (fromLabel === null) return;
          const toLabel = await useUi.getState().askText({ title: "Label at the end (e.g. 1..*)", value: current.toLabel ?? "" });
          if (toLabel === null) return;
          setEdgeField({ fromLabel: fromLabel || undefined, toLabel: toLabel || undefined });
        },
      },
      {
        label: "Line",
        children: LINES.map((l) => ({ label: l[0].toUpperCase() + l.slice(1), checked: (current.line ?? "solid") === l, action: () => setEdgeField({ line: l }, { line: "solid" }) })),
      },
      {
        label: "Start",
        children: ENDS.map((x) => ({ label: x.label, checked: ends.from === x.name, action: () => setEdgeField({ fromEnd: x.name }, { fromEnd: "none" }) })),
      },
      {
        label: "End",
        children: ENDS.map((x) => ({ label: x.label, checked: ends.to === x.name, action: () => setEdgeField({ toEnd: x.name }, { toEnd: "arrow" }) })),
      },
      {
        label: "Reverse direction",
        action: () => setEdgeField({ fromEnd: ends.to, toEnd: ends.from, fromLabel: current.toLabel, toLabel: current.fromLabel }, { fromEnd: "none", toEnd: "arrow" }),
      },
      {
        label: "Thickness",
        children: [
          ["Thin", 1],
          ["Normal", 2],
          ["Thick", 4],
        ].map(([label, w]) => ({ label: label as string, checked: (current.thickness ?? 2) === w, action: () => setEdgeField({ thickness: w as number }, { thickness: 2 }) })),
      },
      { label: "Colour", children: colorItems((c) => setEdgeField({ color: c })) },
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

  /** Lays out the selected cards (or all of them) along their connections. Groups stay where they are. */
  const layoutCards = (direction: "TB" | "LR") => {
    const cards = nodesRef.current.filter((n) => n.type !== "group-card");
    let chosen = cards.filter((n) => n.selected).length >= 2 ? cards.filter((n) => n.selected) : cards;
    if (chosen.length < 2) return;
    // Fork / join bars lie across the flow: upright when it runs left to right, flat when top to bottom.
    chosen = chosen.map((n) => {
      const nd = n.data.node;
      const w = n.measured?.width ?? nd.width;
      const h = n.measured?.height ?? nd.height;
      if (nd.shape !== "bar" || (direction === "LR") === h > w) return n;
      return { ...n, width: h, height: w, measured: { width: h, height: w }, data: { ...n.data, node: { ...nd, width: h, height: w } } };
    });
    const turned = new Map(chosen.map((n) => [n.id, n]));
    nodesRef.current = nodesRef.current.map((n) => turned.get(n.id) ?? n);
    const boxes = chosen.map((n) => ({ id: n.id, ...n.position, width: n.measured?.width ?? n.data.node.width, height: n.measured?.height ?? n.data.node.height }));
    const pos = autoLayout(boxes, edgesRef.current.map((e) => ({ from: e.source, to: e.target })), direction);
    nodesRef.current = nodesRef.current.map((n) => {
      const p = pos.get(n.id);
      return p ? { ...n, position: p, data: { ...n.data, node: { ...n.data.node, ...p } } } : n;
    });
    setNodes(nodesRef.current);
    // Connections between laid-out cards pick their sides again from the new positions.
    const byId = new Map(nodesRef.current.map((n) => [n.id, n.data.node]));
    edgesRef.current = edgesRef.current.map((e) => {
      if (!pos.has(e.source) || !pos.has(e.target)) return e;
      const orig = { ...(e.data?.edge as CanvasEdge) };
      for (const k of ["fromSide", "toSide", "fromOffset", "toOffset"]) delete (orig as Record<string, unknown>)[k];
      return toFlowEdge(orig, byId);
    });
    setEdges(edgesRef.current);
    queueMicrotask(() => {
      commitRef.current();
      void flow.fitView({ padding: 0.2, duration: 200 });
    });
  };

  const tools = toolsHost;
  return (
    <div
      ref={hostRef}
      className={`canvas-host ${presenting ? "presenting" : ""}`}
      onDragOver={(e) => (e.dataTransfer.types.includes(TREE_DRAG) || isFinderDrag(e.dataTransfer)) && e.preventDefault()}
      onDrop={onDrop}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).classList.contains("react-flow__pane")) addNode({ type: "text", text: "" }, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
    >
      {tools && (
        <CanvasTools
          onCard={() => addNode({ type: "text", text: "" })}
          onShape={(shape) => {
            const sh = SHAPES.find((x) => x.name === shape)!;
            addNode({ type: "text", text: "", shape, width: sh.width, height: sh.height });
          }}
          onGroup={() => addNode({ type: "group", label: "Group" })}
          onFile={() => void addFile()}
          onFit={() => void flow.fitView({ padding: 0.2, duration: 200 })}
          onLayout={layoutCards}
          onMore={(r) =>
            useUi.getState().showMenu(r.left, r.bottom + 4, [
              {
                label: "Copy as Mermaid",
                action: () => {
                  void navigator.clipboard.writeText(canvasToMermaid(docRef.current)).catch((e) => useVault.getState().setError(`Couldn't copy: ${errorMessage(e)}`));
                },
              },
              { label: "Present", action: present },
              ...(["svg", "png"] as const).map((format) => ({
                label: `Export as ${format.toUpperCase()}`,
                action: () => void exportCanvas(path, docRef.current, format).catch((e) => useVault.getState().setError(`Couldn't export: ${errorMessage(e)}`)),
              })),
            ])
          }
          host={tools}
        />
      )}
      <EdgeMarkers used={markers} />
      {presenting && (
        <div className="present-hud">
          {presenting.index + 1} / {presenting.steps.length}
          {presenting.steps[presenting.index].label && ` · ${presenting.steps[presenting.index].label}`}
          <span> · ← → to move, Esc to stop</span>
        </div>
      )}
      <ReactFlow<FlowNode, Edge>
        nodes={shown.nodes}
        edges={shown.edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodeMouseEnter={(_e, n) => !presenting && setHovered(n.id)}
        onNodeMouseLeave={() => setHovered(null)}
        nodesDraggable={!presenting}
        nodesConnectable={!presenting}
        elementsSelectable={!presenting}
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
        <ViewportPortal>
          {guides.x !== undefined && <div className="align-guide vertical" style={{ transform: `translateX(${guides.x}px)` }} />}
          {guides.y !== undefined && <div className="align-guide horizontal" style={{ transform: `translateY(${guides.y}px)` }} />}
        </ViewportPortal>
        {!presenting && <Controls showInteractive={false} />}
        {!presenting && <MiniMap pannable zoomable />}
      </ReactFlow>
    </div>
  );
}

function CanvasTools({
  onCard,
  onShape,
  onGroup,
  onFile,
  onFit,
  onLayout,
  onMore,
  host,
}: {
  onCard(): void;
  onShape(shape: ShapeName): void;
  onGroup(): void;
  onFile(): void;
  onFit(): void;
  onLayout(direction: "TB" | "LR"): void;
  onMore(anchor: DOMRect): void;
  host: HTMLElement;
}) {
  return createPortal(
    <span className="canvas-tools">
      <button onClick={onCard} title="Add a text card (or double-click the canvas)"><Plus size={14} /> Card</button>
      <button
        title="Add a shape: decision, database, actor…"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          useUi.getState().showMenu(
            r.left,
            r.bottom + 4,
            SHAPE_GROUPS.map((g) => ({ label: g, children: SHAPES.filter((sh) => sh.group === g).map((sh) => ({ label: sh.label, action: () => onShape(sh.name) })) })),
          );
        }}
      >
        <Shapes size={14} /> Shape
      </button>
      <button onClick={onFile} title="Add a note or file (or drag one from the sidebar)"><FileText size={14} /> File</button>
      <button onClick={onGroup}><SquareDashed size={14} /> Group</button>
      <button
        title="Arrange the selected cards (or all) along their connections"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          useUi.getState().showMenu(r.left, r.bottom + 4, [
            { label: "Top to bottom", action: () => onLayout("TB") },
            { label: "Left to right", action: () => onLayout("LR") },
          ]);
        }}
      >
        <Network size={14} /> Layout
      </button>
      <button onClick={onFit} title="Fit to view"><Maximize size={14} /></button>
      <button onClick={(e) => onMore(e.currentTarget.getBoundingClientRect())} title="More: copy as Mermaid, export, present" aria-label="More">
        <Ellipsis size={14} />
      </button>
    </span>,
    host,
  );
}

function Handles({ node }: { node: CanvasNode }) {
  const ports = portsOf(node);
  return (
    <>
      {SIDES.flatMap((s) =>
        ports.map((p) => (
          <Handle
            key={handleId(s, p)}
            id={handleId(s, p)}
            type="source"
            position={POS[s]}
            className={`canvas-handle ${p === 0.5 ? "" : "minor"}`}
            style={
              s === "top" || s === "bottom"
                ? { left: `${p * 100}%` }
                : // Sequence messages leave from and arrive at the lifeline itself, not the box's edge.
                  { top: `${p * 100}%`, ...(node.shape === "lifeline" ? { left: "50%" } : {}) }
            }
          />
        )),
      )}
    </>
  );
}

const Card = memo(function Card({ data, selected }: NodeProps<FlowNode>) {
  const n = data.node;
  const color = colorOf(n.color);
  if (n.type === "text" && isShape(n.shape)) return <ShapeCard data={data} selected={selected} shape={n.shape} color={color} />;
  return (
    <div className={`canvas-card ${selected ? "selected" : ""}`} style={color ? { borderColor: color, ["--card-tint" as string]: color } : undefined}>
      <NodeResizer isVisible={selected} minWidth={120} minHeight={60} lineClassName="canvas-resize-line" handleClassName="canvas-resize-handle" />
      <Handles node={n} />
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

/** A text card drawn as a diagram shape: the outline behind, the Markdown text centred on top. */
function ShapeCard({ data, selected, shape, color }: { data: CardData; selected: boolean; shape: ShapeName; color: string | undefined }) {
  const n = data.node;
  const style = { stroke: color ?? "var(--shape-stroke)", fill: color ? `color-mix(in srgb, ${color} 14%, var(--bg))` : "var(--bg)", border: n.border as string | undefined };
  const css = cssShape(shape, style);
  return (
    <div className={`canvas-shape shape-${shape} ${selected ? "selected" : ""} ${css ? "css-shape" : ""}`} style={css ?? undefined}>
      <NodeResizer isVisible={selected} minWidth={60} minHeight={40} lineClassName="canvas-resize-line" handleClassName="canvas-resize-handle" />
      <Handles node={n} />
      {!css && <ShapeOutline shape={shape} style={style} />}
      {!LABELLESS.has(shape) && (
        <div className="shape-text">
          <TextCard id={n.id} text={n.text ?? ""} onText={data.onText} canvasPath={data.canvasPath} compartments={shape === "class"} lineBreaks />
        </div>
      )}
    </div>
  );
}

const GroupCard = memo(function GroupCard({ data, selected }: NodeProps<FlowNode>) {
  const n = data.node;
  const color = colorOf(n.color);
  return (
    <div className={`canvas-group ${selected ? "selected" : ""}`} style={color ? { borderColor: color, background: `${color}14` } : undefined}>
      <NodeResizer isVisible={selected} minWidth={160} minHeight={100} lineClassName="canvas-resize-line" handleClassName="canvas-resize-handle" />
      <Handles node={n} />
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

/**
 * Renders the diagram blocks (Mermaid, Graphviz, Vega-Lite, math) inside static Markdown HTML. The
 * returned `key` changes with the theme, which remounts the element so diagrams redraw in its colours.
 */
function useRenderedBlocks(html: string, path: string) {
  const ref = useRef<HTMLDivElement>(null);
  const dark = useDark();
  useEffect(() => {
    if (ref.current) renderBlocksIn(ref.current, path);
  }, [html, path, dark]);
  return { ref, key: dark ? "dark" : "light" };
}

function TextCard({
  id,
  text,
  onText,
  canvasPath,
  compartments = false,
  lineBreaks = false,
}: {
  id: string;
  text: string;
  onText(id: string, t: string): void;
  canvasPath: string;
  /** UML class boxes: lines of `---` split the text into compartments (name, attributes, operations). */
  compartments?: boolean;
  /** Shape labels keep every line break, like a label rather than a paragraph. */
  lineBreaks?: boolean;
}) {
  const [editing, setEditing] = useState(text === "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const entries = useVault((s) => s.entries);
  const html = useMemo(() => {
    const render = (t: string) => renderMarkdown(t, (target) => resolveLink(target, entries, canvasPath), lineBreaks);
    if (!compartments) return render(text);
    return text
      .split(/^[ \t]*-{3,}[ \t]*$/m)
      .map((part) => `<div class="compartment">${render(part.trim())}</div>`)
      .join("");
  }, [text, entries, canvasPath, compartments, lineBreaks]);
  const onClick = useLinkClicks(canvasPath);
  const body = useRenderedBlocks(html, canvasPath);
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
      {text ? <div key={body.key} ref={body.ref} dangerouslySetInnerHTML={{ __html: html }} /> : <span className="canvas-placeholder">Double-click to write</span>}
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
  const body = useRenderedBlocks(preview?.html ?? "", file);
  return (
    <div className="canvas-file">
      <button className="canvas-file-title nodrag" onClick={(e) => void useWorkspace.getState().open(file, { newTab: e.metaKey })} title={file}>
        {name}
        {subpath ? ` ${subpath}` : ""}
      </button>
      <div className="canvas-file-body nowheel">
        {!exists && <span className="canvas-placeholder">File not found: {file}</span>}
        {preview?.img && <img src={preview.img} alt={file} />}
        {preview?.html && <div key={body.key} ref={body.ref} className="md-render" dangerouslySetInnerHTML={{ __html: preview.html }} />}
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
