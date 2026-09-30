import { create } from "zustand";
import { api } from "../ipc/api";
import { errorMessage, type Entry, type VaultInfo } from "../ipc/types";

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

    async openVault(path) {
      try {
        const vault = await api.openVault(path);
        set({ vault, entries: [], expanded: new Set(), renaming: null, error: null });
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    async refresh() {
      try {
        const [entries, aliases] = await Promise.all([api.list("", true), api.aliases().catch(() => [])]);
        set((s) => ({ entries, aliases, revision: s.revision + 1 }));
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
        const { useWorkspace } = await import("./workspace");
        for (const p of updated_links_in) {
          const b = useWorkspace.getState().buffers[p];
          if (b && !b.dirty) void useWorkspace.getState().reload(p);
        }
        const expanded = new Set(
          [...get().expanded].map((p) => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p)),
        );
        set({ expanded });
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
  };
});
