// Open files: panes (split views) holding tabs, plus one text buffer per open path shared by every tab
// showing it. Buffers autosave with the hash they were read at, so a file changed on disk is never
// silently overwritten.

import { create } from "zustand";
import { api } from "../ipc/api";
import { errorMessage, isCoreError, type FileKind } from "../ipc/types";
import { useVault } from "./vault";

export interface Buffer {
  path: string;
  kind: FileKind;
  /** `null` for binary files (images, PDF). */
  content: string | null;
  /** Hash of the content on disk that this buffer is based on. */
  baseHash: string;
  dirty: boolean;
  /** Set when disk and buffer diverged; the UI asks the user what to do. */
  conflict: { diskHash: string | null } | null;
  deleted: boolean;
  error: string | null;
  /** Bumped when content is replaced from disk, so editors know to reload. */
  version: number;
}

export interface Pane {
  id: string;
  tabs: string[];
  active: string | null;
}

export type SplitDirection = "row" | "column";

interface WorkspaceState {
  panes: Pane[];
  direction: SplitDirection;
  focused: string;
  buffers: Record<string, Buffer>;

  open(path: string, opts?: { newTab?: boolean; pane?: string }): Promise<void>;
  closeTab(paneId: string, path: string): void;
  focus(paneId: string): void;
  activate(paneId: string, path: string): void;
  split(direction: SplitDirection): void;
  closePane(paneId: string): void;
  moveTab(path: string, from: string, to: string, index?: number): void;
  edit(path: string, content: string): void;
  save(path: string): Promise<void>;
  reload(path: string): Promise<void>;
  keepMine(path: string): Promise<void>;
  renamed(from: string, to: string): void;
  deleted(path: string): void;
  activePath(): string | null;
}

let paneSeq = 1;
const newPaneId = () => `pane-${paneSeq++}`;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const AUTOSAVE_MS = 400;

function remap(p: string, from: string, to: string): string {
  return p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p;
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  const updateBuffer = (path: string, patch: Partial<Buffer>) =>
    set((s) => (s.buffers[path] ? { buffers: { ...s.buffers, [path]: { ...s.buffers[path], ...patch } } } : s));

  const load = async (path: string) => {
    try {
      const f = await api.read(path);
      const prev = get().buffers[path];
      set((s) => ({
        buffers: {
          ...s.buffers,
          [path]: {
            path,
            kind: f.kind,
            content: f.content,
            baseHash: f.hash,
            dirty: false,
            conflict: null,
            deleted: false,
            error: null,
            version: (prev?.version ?? 0) + 1,
          },
        },
      }));
    } catch (e) {
      set((s) => ({
        buffers: {
          ...s.buffers,
          [path]: {
            path, kind: "other", content: null, baseHash: "", dirty: false, conflict: null,
            deleted: isCoreError(e) && e.code === "not_found", error: errorMessage(e), version: 1,
          },
        },
      }));
    }
  };

  const dropUnusedBuffers = () =>
    set((s) => {
      const open = new Set(s.panes.flatMap((p) => p.tabs));
      const buffers = Object.fromEntries(Object.entries(s.buffers).filter(([p, b]) => open.has(p) || b.dirty));
      return { buffers };
    });

  const first = newPaneId();
  return {
    panes: [{ id: first, tabs: [], active: null }],
    direction: "row",
    focused: first,
    buffers: {},

    async open(path, opts = {}) {
      const paneId = opts.pane ?? get().focused;
      set((s) => ({
        focused: paneId,
        panes: s.panes.map((p) => {
          if (p.id !== paneId) return p;
          if (p.tabs.includes(path)) return { ...p, active: path };
          const tabs = [...p.tabs];
          const at = p.active ? tabs.indexOf(p.active) : -1;
          const activeBuf = p.active ? s.buffers[p.active] : undefined;
          // Like Obsidian: without "new tab", replace the current tab unless it has unsaved edits.
          if (!opts.newTab && at >= 0 && !activeBuf?.dirty) tabs[at] = path;
          else tabs.splice(at + 1, 0, path);
          return { ...p, tabs, active: path };
        }),
      }));
      if (!get().buffers[path]) await load(path);
      dropUnusedBuffers();
    },

    closeTab(paneId, path) {
      set((s) => ({
        panes: s.panes.map((p) => {
          if (p.id !== paneId) return p;
          const i = p.tabs.indexOf(path);
          const tabs = p.tabs.filter((t) => t !== path);
          const active = p.active === path ? (tabs[Math.min(i, tabs.length - 1)] ?? null) : p.active;
          return { ...p, tabs, active };
        }),
      }));
      const pane = get().panes.find((p) => p.id === paneId);
      if (pane && pane.tabs.length === 0 && get().panes.length > 1) get().closePane(paneId);
      dropUnusedBuffers();
    },

    focus: (focused) => set({ focused }),

    activate(paneId, path) {
      set((s) => ({ focused: paneId, panes: s.panes.map((p) => (p.id === paneId ? { ...p, active: path } : p)) }));
    },

    split(direction) {
      const src = get().panes.find((p) => p.id === get().focused);
      const id = newPaneId();
      const tabs = src?.active ? [src.active] : [];
      set((s) => {
        const at = s.panes.findIndex((p) => p.id === s.focused);
        const panes = [...s.panes];
        panes.splice(at + 1, 0, { id, tabs, active: tabs[0] ?? null });
        return { panes, direction, focused: id };
      });
    },

    closePane(paneId) {
      set((s) => {
        if (s.panes.length === 1) return s;
        const panes = s.panes.filter((p) => p.id !== paneId);
        return { panes, focused: s.focused === paneId ? panes[0].id : s.focused };
      });
      dropUnusedBuffers();
    },

    moveTab(path, from, to, index) {
      set((s) => ({
        focused: to,
        panes: s.panes.map((p) => {
          if (p.id === from && from !== to) {
            const tabs = p.tabs.filter((t) => t !== path);
            return { ...p, tabs, active: p.active === path ? (tabs[0] ?? null) : p.active };
          }
          if (p.id === to) {
            const tabs = p.tabs.filter((t) => t !== path);
            tabs.splice(index ?? tabs.length, 0, path);
            return { ...p, tabs, active: path };
          }
          return p;
        }),
      }));
      const src = get().panes.find((p) => p.id === from);
      if (src && src.tabs.length === 0 && get().panes.length > 1) get().closePane(from);
    },

    edit(path, content) {
      const b = get().buffers[path];
      if (!b || b.content === content) return;
      updateBuffer(path, { content, dirty: true });
      clearTimeout(saveTimers.get(path));
      saveTimers.set(path, setTimeout(() => void get().save(path), AUTOSAVE_MS));
    },

    async save(path) {
      clearTimeout(saveTimers.get(path));
      const b = get().buffers[path];
      if (!b || !b.dirty || b.content === null || b.conflict || b.deleted) return;
      const content = b.content;
      try {
        const w = await api.write(path, content, b.baseHash || null);
        const now = get().buffers[path];
        if (now) updateBuffer(path, { baseHash: w.hash, dirty: now.content !== content, error: null });
        useVault.getState().touched();
      } catch (e) {
        if (isCoreError(e) && e.code === "conflict") updateBuffer(path, { conflict: { diskHash: e.current_hash } });
        else updateBuffer(path, { error: errorMessage(e) });
      }
    },

    async reload(path) {
      clearTimeout(saveTimers.get(path));
      await load(path);
    },

    async keepMine(path) {
      const b = get().buffers[path];
      if (!b) return;
      updateBuffer(path, { conflict: null, deleted: false, baseHash: b.conflict?.diskHash ?? "", dirty: true });
      await get().save(path);
    },

    renamed(from, to) {
      set((s) => {
        const buffers: Record<string, Buffer> = {};
        for (const [p, b] of Object.entries(s.buffers)) {
          const np = remap(p, from, to);
          buffers[np] = np === p ? b : { ...b, path: np };
        }
        const panes = s.panes.map((p) => ({
          ...p,
          tabs: p.tabs.map((t) => remap(t, from, to)),
          active: p.active ? remap(p.active, from, to) : null,
        }));
        return { buffers, panes };
      });
    },

    deleted(path) {
      const under = (p: string) => p === path || p.startsWith(`${path}/`);
      for (const pane of get().panes) {
        for (const t of pane.tabs) {
          if (!under(t)) continue;
          if (get().buffers[t]?.dirty) updateBuffer(t, { deleted: true });
          else get().closeTab(pane.id, t);
        }
      }
    },

    activePath() {
      const s = get();
      return s.panes.find((p) => p.id === s.focused)?.active ?? null;
    },
  };
});
