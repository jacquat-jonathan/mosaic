// Frontmatter properties as a form: read each property with an inferred type, and change one at a time
// while keeping the rest of the YAML as written (comments, order, quoting).

import { isMap, isScalar, isSeq, parseDocument } from "yaml";

export type PropKind = "list" | "checkbox" | "date" | "number" | "text" | "other";

export interface Prop {
  key: string;
  kind: PropKind;
  value: unknown;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function kindOf(value: unknown): PropKind {
  if (Array.isArray(value)) return value.every((v) => typeof v !== "object" || v === null) ? "list" : "other";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (value instanceof Date) return "date";
  if (typeof value === "string") return DATE.test(value) ? "date" : "text";
  if (value === null || value === undefined) return "text";
  return "other";
}

/** The properties in a frontmatter block, in order. Throws on invalid YAML. */
export function readProps(yaml: string): Prop[] {
  const doc = parseDocument(yaml);
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  const map = doc.contents;
  if (!map) return [];
  if (!isMap(map)) throw new Error("The frontmatter isn't a list of properties.");
  // The default (core) schema keeps dates as strings, as written.
  const data = (doc.toJS() ?? {}) as Record<string, unknown>;
  return map.items.map((pair) => {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    const value = data[key] ?? null;
    return { key, kind: kindOf(value), value };
  });
}

function edit(yaml: string, change: (doc: ReturnType<typeof parseDocument>) => void): string {
  const doc = parseDocument(yaml);
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  change(doc);
  // No line wrapping, and flow lists stay as people write them: [a, b], not [ a, b ].
  const out = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  return out === "{}\n" || out === "null\n" ? "" : out;
}

/** Sets a property's value (adding it at the end if it's new). */
export function setProp(yaml: string, key: string, value: unknown): string {
  return edit(yaml, (doc) => {
    if (!doc.contents) doc.contents = doc.createNode({}) as never;
    const node = doc.createNode(value);
    // A list keeps the style it was written in ([a, b] or one item per line); new lists are block lists.
    const before = doc.get(key, true);
    if (isSeq(node)) node.flow = isSeq(before) ? !!before.flow : false;
    doc.set(key, node);
  });
}

export function removeProp(yaml: string, key: string): string {
  return edit(yaml, (doc) => {
    doc.delete(key);
  });
}

/** Renames a property in place, keeping its value and position. */
export function renameProp(yaml: string, from: string, to: string): string {
  if (!to.trim() || from === to) return yaml;
  return edit(yaml, (doc) => {
    const map = doc.contents;
    if (!isMap(map)) return;
    if (map.has(to)) throw new Error(`There's already a property called “${to}”.`);
    const pair = map.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === from);
    if (pair) pair.key = doc.createNode(to.trim()) as never;
  });
}

/** An empty value of each kind, for "Add property". */
export function emptyValue(kind: PropKind): unknown {
  switch (kind) {
    case "list":
      return [];
    case "checkbox":
      return false;
    case "number":
      return 0;
    case "date":
      return new Date().toISOString().slice(0, 10);
    default:
      return "";
  }
}
