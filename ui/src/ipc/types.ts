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

export interface RecentVault extends VaultInfo {
  /** False when the folder is gone (deleted, or on an unplugged disk). */
  exists: boolean;
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

export interface CliInfo {
  path: string | null;
  link: string;
  installed: boolean;
}

export interface UpdateStatus {
  version: string;
  /** Short commit the app was built from ("" if unknown). */
  commit: string;
  source_dir: string;
  /** Why the source folder can't be used, if it can't. */
  source_problem: string | null;
  /** The installed .app; null for a development build. */
  app_path: string | null;
  running: boolean;
  ready_to_install: boolean;
  /** Why the last "Restart to finish" couldn't install the new build. */
  last_install_error: string | null;
}

export interface Release {
  version: string;
  date: string;
  /** Top-level bullet points of the release in CHANGELOG.md. */
  notes: string[];
}

export interface UpdateCheck {
  branch: string;
  upstream: string;
  /** The version on the upstream branch, if its Cargo.toml could be read. */
  latest_version: string | null;
  /** Releases newer than this app, newest first. */
  releases: Release[];
  behind: { hash: string; subject: string }[];
  ahead: number;
  source_head: string;
  installed_outdated: boolean;
  dirty: boolean;
}

export interface UpdateDone {
  ok: boolean;
  cancelled: boolean;
  error: string | null;
}
