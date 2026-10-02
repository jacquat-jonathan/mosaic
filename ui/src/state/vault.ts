import { create } from "zustand";
import { api } from "../ipc/api";
import { errorMessage, type Entry, type VaultInfo } from "../ipc/types";
import { useWorkspace } from "./workspace";

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** First free "<stem>.<ext>", "<stem> 1.<ext>", … among existing paths. */
export function uniquePath(existing: Set<string>, dir: string, stem: string, ext: string): string {
  const dot = ext ? `.${ext}` : "";
  for (let i = 0; ; i++) {
    const p = joinPath(dir, `${i === 0 ? stem : `${stem} ${i}`}${dot}`);
    if (!existing.has(p.toLowerCase())) return p;
  }
}

/** Maps a path through a move of `from` to `to` (also for paths inside a moved folder). */
export function remapPath(p: string, from: string, to: string): string {
  return p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p;
}

/** Paths from `a` to `b` (inclusive, either order) in the visible `order`; just `[b]` if `a` isn't visible. */
export function rangeBetween(order: string[], a: string | null, b: string): string[] {
  const j = order.indexOf(b);
  const i = a === null ? -1 : order.indexOf(a);
  if (i < 0 || j < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** Drops paths that sit inside another path of the list, so a folder and its contents move once. */
export function topLevel(paths: string[]): string[] {
  const set = new Set(paths);
  return paths.filter((p) => {
    for (let d = parentOf(p); d; d = parentOf(d)) if (set.has(d)) return false;
    return true;
  });
}

interface VaultState {
  vault: VaultInfo | null;
  entries: Entry[];
  expanded: Set<string>;
  /** Path currently being renamed inline in the tree. */
  renaming: string | null;
  error: string | null;
  /** Bumped on every change to vault content, so derived views (backlinks, tags) refetch. */
  revision: number;
  indexing: { done: number; total: number } | null;
  /** Frontmatter aliases: [alias, path]. */
  aliases: [string, string][];
  /** The vault folder disappeared (unmounted disk, moved folder). */
  offline: boolean;
  /** Tree selection (multi-select with ⌘ / ⇧ click). */
  selected: Set<string>;
  /** Where a ⇧-click (or ⇧-arrow) range starts. */
  anchor: string | null;
  /** The keyboard cursor: where arrow keys move from, the moving end of a ⇧ range. */
  cursor: string | null;
  /** Bookmarked vault-relative paths, in the user's order. */
  bookmarks: string[];

  openVault(path: string): Promise<void>;
  refresh(): Promise<void>;
  toggle(dir: string, open?: boolean): void;
  revealParents(path: string): void;
  setRenaming(path: string | null): void;
  newFile(dir: string, stem: string, ext: string, content?: string): Promise<string | null>;
  newFolder(dir: string): Promise<string | null>;
  rename(from: string, to: string): Promise<string | null>;
  remove(path: string): Promise<boolean>;
  setError(msg: string | null): void;
  touched(): void;
  /** `order` is the visible tree order, needed for ⇧-click ranges. */
  select(path: string, mode: "single" | "toggle" | "range", order?: string[]): void;
  /** Arrow keys: moves the cursor one row; with `extend` (⇧), selects from the anchor to it. */
  step(delta: 1 | -1, extend: boolean, order: string[]): string | null;
  setSelection(paths: string[]): void;
  clearSelection(): void;
  setBookmarks(paths: string[]): Promise<void>;
  toggleBookmark(path: string): Promise<void>;
  toggleBookmarks(paths: string[]): Promise<void>;
}

export const useVault = create<VaultState>((set, get) => {
  const fail = (e: unknown) => {
    set({ error: errorMessage(e) });
    return null;
  };
  const existing = () => new Set(get().entries.map((e) => e.path.toLowerCase()));

  return {
    vault: null,
    entries: [],
    expanded: new Set(),
    renaming: null,
    error: null,
    revision: 0,
    indexing: null,
    aliases: [],
    offline: false,
    selected: new Set(),
    anchor: null,
    cursor: null,
    bookmarks: [],

    async openVault(path) {
      try {
        const vault = await api.openVault(path);
        set({ vault, entries: [], expanded: new Set(), renaming: null, error: null, offline: false, selected: new Set(), anchor: null, bookmarks: [] });
        await get().refresh();
        set({ bookmarks: await api.bookmarks().catch(() => []) });
        await useWorkspace.getState().restoreLayout(vault.root);
      } catch (e) {
        fail(e);
      }
    },

    async refresh() {
      try {
        const [entries, aliases] = await Promise.all([api.list("", true), api.aliases().catch(() => [])]);
        const paths = new Set(entries.map((e) => e.path));
        set((s) => {
          const selected = [...s.selected].every((p) => paths.has(p)) ? s.selected : new Set([...s.selected].filter((p) => paths.has(p)));
          return { entries, aliases, revision: s.revision + 1, selected };
        });
      } catch (e) {
        fail(e);
      }
    },

    toggle(dir, open) {
      const expanded = new Set(get().expanded);
      const shouldOpen = open ?? !expanded.has(dir);
      if (shouldOpen) expanded.add(dir);
      else expanded.delete(dir);
      set({ expanded });
    },

    revealParents(path) {
      const expanded = new Set(get().expanded);
      for (let p = parentOf(path); p; p = parentOf(p)) expanded.add(p);
      set({ expanded });
    },

    setRenaming: (renaming) => set({ renaming }),

    async newFile(dir, stem, ext, content = "") {
      const path = uniquePath(existing(), dir, stem, ext);
      try {
        await api.create(path, content);
        if (dir) get().toggle(dir, true);
        await get().refresh();
        return path;
      } catch (e) {
        return fail(e);
      }
    },

    async newFolder(dir) {
      const path = uniquePath(existing(), dir, "New folder", "");
      try {
        await api.mkdir(path);
        if (dir) get().toggle(dir, true);
        await get().refresh();
        set({ renaming: path });
        return path;
      } catch (e) {
        return fail(e);
      }
    },

    async rename(from, to) {
      if (from === to) return from;
      try {
        const { path: out, updated_links_in } = await api.rename(from, to);
        // Reload open notes whose links were rewritten (unsaved ones get the conflict prompt).
        for (const p of updated_links_in) {
          const b = useWorkspace.getState().buffers[p];
          if (b && !b.dirty) void useWorkspace.getState().reload(p);
        }
        const expanded = new Set([...get().expanded].map((p) => remapPath(p, from, out)));
        const selected = new Set([...get().selected].map((p) => remapPath(p, from, out)));
        const anchor = get().anchor === null ? null : remapPath(get().anchor!, from, out);
        set({ expanded, selected, anchor });
        const bookmarks = get().bookmarks.map((p) => remapPath(p, from, out));
        if (bookmarks.some((p, i) => p !== get().bookmarks[i])) void get().setBookmarks(bookmarks);
        get().revealParents(out);
        await get().refresh();
        return out;
      } catch (e) {
        return fail(e);
      }
    },

    async remove(path) {
      try {
        await api.remove(path);
        await get().refresh();
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    setError: (error) => set({ error }),
    touched: () => set((s) => ({ revision: s.revision + 1 })),

    select(path, mode, order = []) {
      const s = get();
      if (mode === "single") set({ selected: new Set([path]), anchor: path, cursor: path });
      else if (mode === "toggle") {
        const selected = new Set(s.selected);
        if (selected.has(path)) selected.delete(path);
        else selected.add(path);
        set({ selected, anchor: path, cursor: path });
      } else set({ selected: new Set(rangeBetween(order, s.anchor, path)), cursor: path });
    },
    step(delta, extend, order) {
      const s = get();
      const from = s.cursor ?? s.anchor;
      const i = from ? order.indexOf(from) : -1;
      const next = order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + delta))];
      if (!next) return null;
      if (extend && s.anchor && order.includes(s.anchor)) set({ selected: new Set(rangeBetween(order, s.anchor, next)), cursor: next });
      else get().select(next, "single");
      return next;
    },
    setSelection: (paths) => set({ selected: new Set(paths), anchor: paths[paths.length - 1] ?? null, cursor: paths[paths.length - 1] ?? null }),
    clearSelection: () => set({ selected: new Set(), anchor: null, cursor: null }),

    async setBookmarks(paths) {
      const prev = get().bookmarks;
      set({ bookmarks: paths });
      try {
        await api.setBookmarks(paths);
      } catch (e) {
        set({ bookmarks: prev });
        fail(e);
      }
    },
    async toggleBookmark(path) {
      const b = get().bookmarks;
      await get().setBookmarks(b.includes(path) ? b.filter((p) => p !== path) : [...b, path]);
    },
    /** Bookmarks all of `paths`, or removes them all when every one is already bookmarked. */
    async toggleBookmarks(paths) {
      const b = get().bookmarks;
      const all = paths.every((p) => b.includes(p));
      await get().setBookmarks(all ? b.filter((p) => !paths.includes(p)) : [...b, ...paths.filter((p) => !b.includes(p))]);
    },
  };
});
