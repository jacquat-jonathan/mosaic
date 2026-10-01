// JSON Canvas 1.0 (https://jsoncanvas.org) — the format Obsidian uses for .canvas files.
// Unknown fields are preserved on save so files written by other tools survive a round trip.

export type Side = "top" | "right" | "bottom" | "left";

export interface CanvasNode {
  id: string;
  /** "text" | "file" | "link" | "group", or a type from a newer tool, which is kept as is. */
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
  [extra: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: Side;
  toSide?: Side;
  fromEnd?: "none" | "arrow";
  toEnd?: "none" | "arrow";
  color?: string;
  label?: string;
  [extra: string]: unknown;
}

export interface CanvasDoc {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [extra: string]: unknown;
}

export class CanvasParseError extends Error {}

export function parseCanvas(text: string): CanvasDoc {
  if (!text.trim()) return { nodes: [], edges: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new CanvasParseError(`Not valid JSON: ${(e as Error).message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new CanvasParseError("A canvas must be a JSON object.");
  const doc = data as Partial<CanvasDoc>;
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const edges = Array.isArray(doc.edges) ? doc.edges : [];
  for (const n of nodes) {
    if (typeof n?.id !== "string" || typeof n.type !== "string") {
      throw new CanvasParseError(`Invalid node: ${JSON.stringify(n).slice(0, 120)}`);
    }
  }
  return { ...doc, nodes, edges } as CanvasDoc;
}

export const KNOWN_NODE_TYPES = ["text", "file", "link", "group"];

/** Obsidian writes canvases with tab indentation. */
export function serializeCanvas(doc: CanvasDoc): string {
  return JSON.stringify(doc, null, "\t");
}

/** Preset colours "1"–"6" (red, orange, yellow, green, cyan, purple) or any hex value. */
export const PRESET_COLORS: Record<string, string> = {
  "1": "#e5484d",
  "2": "#f76b15",
  "3": "#e2b400",
  "4": "#30a46c",
  "5": "#05a2c2",
  "6": "#8e4ec6",
};

export function colorOf(c: string | undefined): string | undefined {
  if (!c) return undefined;
  return PRESET_COLORS[c] ?? (c.startsWith("#") ? c : undefined);
}

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
