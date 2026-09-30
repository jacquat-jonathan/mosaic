// Mirrors of the serialized mosaic-core types.

export type FileKind =
  | "markdown"
  | "canvas"
  | "excalidraw"
  | "html"
  | "image"
  | "pdf"
  | "csv"
  | "json"
  | "yaml"
  | "graphviz"
  | "code"
  | "text"
  | "other";

export interface Entry {
  path: string;
  name: string;
  is_dir: boolean;
  kind: FileKind | null;
  size: number;
  mtime: number;
}

export interface FileContent {
  path: string;
  kind: FileKind;
  size: number;
  mtime: number;
  hash: string;
  content: string | null;
}

export interface Written {
  path: string;
  hash: string;
}

export interface VaultInfo {
  root: string;
  name: string;
}

export interface CoreError {
  code:
    | "not_found"
    | "already_exists"
    | "conflict"
    | "invalid_path"
    | "not_text"
    | "invalid"
    | "io";
  message: string;
  current_hash: string | null;
}

export function isCoreError(e: unknown): e is CoreError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

export function errorMessage(e: unknown): string {
  if (isCoreError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface SearchHit {
  path: string;
  title: string;
  /** Excerpt with matched terms wrapped in `**`. */
  snippet: string;
  score: number;
}

export interface Backlink {
  source: string;
  line: number;
  context: string;
  embed: boolean;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface Renamed {
  path: string;
  updated_links_in: string[];
}

export interface IndexProgress {
  done: number;
  total: number;
  finished: boolean;
}
