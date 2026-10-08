// Open files: panes (split views) holding tabs, plus one text buffer per open path shared by every tab
// showing it. Buffers autosave with the hash they were read at, so a file changed on disk is never
// silently overwritten.

import { create } from "zustand";
import { mirrorAgentsSoon } from "../sync";
import { isSpecialTab } from "../views/specialTabs";
import { api } from "../ipc/api";
import { errorMessage, isCoreError, type FileKind } from "../ipc/types";
import { useVault } from "./vault";
import { vaultPrefs } from "./vaultPreferences";
import { hasDraft, leaveDraft } from "./drafts";
import { prefs } from "./settings";
import { useUi } from "./ui";

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
  /** Relative size (flex-grow) within the split. */
  size?: number;
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
  /** Opens `path` (a tab dragged from pane `from`) in a new pane next to `beside`; the tab leaves
   *  `from` unless it's that pane's only tab. */
  splitWith(path: string, from: string, beside: string, direction: SplitDirection): void;
  closePane(paneId: string): void;
  moveTab(path: string, from: string, to: string, index?: number): void;
  edit(path: string, content: string): void;
  replaceContent(path: string, content: string): void;
  save(path: string): Promise<void>;
  reload(path: string): Promise<void>;
  /** Loads a file's buffer if it isn't loaded yet (a restored tab shown for the first time). */
  ensure(path: string): Promise<void>;
  keepMine(path: string): Promise<void>;
  /** Reconciles an open buffer with a change on disk made outside the app. */
  externalChange(path: string): Promise<void>;
  renamed(from: string, to: string): void;
  deleted(path: string): void;
  activePath(): string | null;
  resize(index: number, delta: number): void;
  /** Restores the tabs and splits last used with this vault. */
  restoreLayout(root: string): Promise<void>;
}

/** Accept the original string-tab layout and sanitize it before using it as workspace state. */
export function migrateLayout(value: unknown): { panes: Pane[]; direction: SplitDirection; focused: string } | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as { panes?: unknown; direction?: unknown; focused?: unknown };
  if (!Array.isArray(saved.panes)) return null;
  const panes: Pane[] = saved.panes.filter(p => p && Array.isArray(p.tabs)).map((p, i) => {
    const tabs: string[] = [...new Set<string>(p.tabs.filter((t: unknown): t is string => typeof t === "string" && !!t))];
    return { id: typeof p.id === "string" ? p.id : `restored-${i}`, tabs, active: tabs.includes(p.active) ? p.active : tabs[0] ?? null, size: typeof p.size === "number" && Number.isFinite(p.size) && p.size > 0 ? p.size : 1 };
  });
  if (!panes.length) return null;
  return { panes, direction: saved.direction === "column" ? "column" : "row", focused: panes.some(p => p.id === saved.focused) ? saved.focused as string : panes[0].id };
}

let paneSeq = 1;
const newPaneId = () => `pane-${paneSeq++}`;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const saving = new Set<string>();
let layoutRoot: string | null = null;
export const AUTOSAVE_MS = 400;

function remap(p: string, from: string, to: string): string {
  return p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p;
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  const updateBuffer = (path: string, patch: Partial<Buffer>) =>
    set((s) => (s.buffers[path] ? { buffers: { ...s.buffers, [path]: { ...s.buffers[path], ...patch } } } : s));

  const load = async (path: string) => {
    // A view, not a file: an empty buffer so the tab shows (FileView draws the view).
    if (isSpecialTab(path)) {
      set((s) => ({
        buffers: { ...s.buffers, [path]: { path, kind: "other", content: null, baseHash: "", dirty: false, conflict: null, deleted: false, error: null, version: 1 } },
      }));
      return;
    }
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

  /** Paths being loaded by `ensure`, so a re-render doesn't start a second read. */
  const loading = new Set<string>();

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
      const previous = get().panes.find(p => p.id === paneId)?.active ?? null;
      if (previous !== path && !(await leaveDraft(previous))) return;
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
      if (hasDraft(path)) {
        void leaveDraft(path).then(ok => { if (ok) get().closeTab(paneId, path); });
        return;
      }
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
      const previous = get().panes.find(p => p.id === paneId)?.active ?? null;
      if (previous !== path && previous && hasDraft(previous)) {
        void leaveDraft(previous).then(ok => { if (ok) set(s => ({ focused: paneId, panes: s.panes.map(p => p.id === paneId ? { ...p, active: path } : p) })); }); return;
      }
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

    splitWith(path, from, beside, direction) {
      const id = newPaneId();
      set((s) => {
        const panes = s.panes.map((p) => {
          if (p.id !== from || p.tabs.length < 2) return p;
          const tabs = p.tabs.filter((t) => t !== path);
          return { ...p, tabs, active: p.active === path ? tabs[Math.max(0, p.tabs.indexOf(path) - 1)] : p.active };
        });
        const at = panes.findIndex((p) => p.id === beside);
        panes.splice(at + 1, 0, { id, tabs: [path], active: path });
        return { panes, direction, focused: id };
      });
    },

    closePane(paneId) {
      const drafts = get().panes.find(p => p.id === paneId)?.tabs.filter(hasDraft) ?? [];
      if (drafts.length) {
        void (async () => { for(const path of drafts) if(!(await leaveDraft(path))) return; get().closePane(paneId); })(); return;
      }
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

    replaceContent(path, content) {
      get().edit(path, content);
      const b = get().buffers[path];
      if (b) updateBuffer(path, { version: b.version + 1 });
    },

    async save(path) {
      clearTimeout(saveTimers.get(path));
      const b = get().buffers[path];
      if (!b || !b.dirty || b.content === null || b.conflict || b.deleted) return;
      const content = b.content;
      saving.add(path);
      try {
        const w = await api.write(path, content, b.baseHash || null);
        const now = get().buffers[path];
        if (now) updateBuffer(path, { baseHash: w.hash, dirty: now.content !== content, error: null });
        if (path.startsWith(`${vaultPrefs().agents_folder}/`)) mirrorAgentsSoon();
        useVault.getState().touched();
      } catch (e) {
        if (isCoreError(e) && e.code === "conflict") updateBuffer(path, { conflict: { diskHash: e.current_hash } });
        else updateBuffer(path, { error: errorMessage(e) });
      } finally {
        saving.delete(path);
      }
    },

    async externalChange(path) {
      const b = get().buffers[path];
      if (!b || saving.has(path)) return;
      let disk: Awaited<ReturnType<typeof api.read>> | null = null;
      try {
        disk = await api.read(path);
      } catch (e) {
        if (!(isCoreError(e) && e.code === "not_found")) return;
      }
      const now = get().buffers[path];
      if (!now) return;
      if (!disk) {
        // Deleted on disk: close clean tabs; keep dirty ones and ask.
        if (now.dirty) updateBuffer(path, { deleted: true });
        else get().deleted(path);
        return;
      }
      if (disk.hash === now.baseHash) return; // our own save, or no real change
      if (!now.dirty) {
        const prev = now.version;
        set((s) => ({
          buffers: {
            ...s.buffers,
            [path]: { ...now, content: disk.content, kind: disk.kind, baseHash: disk.hash, conflict: null, deleted: false, error: null, version: prev + 1 },
          },
        }));
      } else {
        updateBuffer(path, { conflict: { diskHash: disk.hash } });
      }
    },

    async ensure(path) {
      if (!get().buffers[path] && !loading.has(path)) {
        loading.add(path);
        try {
          await load(path);
        } finally {
          loading.delete(path);
        }
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

    resize(index, delta) {
      // Moves `delta` (a fraction of the total) from pane index+1 to pane index.
      set((s) => {
        const panes = s.panes.map((p) => ({ ...p, size: p.size ?? 1 }));
        const total = panes.reduce((n, p) => n + (p.size ?? 1), 0);
        const d = delta * total;
        const a = panes[index];
        const b = panes[index + 1];
        if (!a || !b) return s;
        const min = total * 0.1;
        const next = Math.max(min, Math.min(a.size! + b.size! - min, a.size! + d));
        b.size = a.size! + b.size! - next;
        a.size = next;
        return { panes };
      });
    },

    async restoreLayout(root) {
      layoutRoot = root;
      let saved: Pick<WorkspaceState, "panes" | "direction" | "focused"> | null = null;
      try {
        saved = migrateLayout(JSON.parse(localStorage.getItem(`mosaic:layout:${root}`) ?? "null"));
      } catch {
        saved = null;
      }
      const id = newPaneId();
      if (!saved?.panes?.length) {
        if (!localStorage.getItem("mosaic:ui")) {
          const defaults = prefs();
          useUi.setState({ sidebarWidth: defaults.sidebarWidth, rightWidth: defaults.contextWidth, leftSidebar: defaults.sidebarVisible, rightPanel: defaults.contextVisible });
        }
        set({ panes: [{ id, tabs: [], active: null }], focused: id, buffers: {}, direction: "row" });
        return;
      }
      const panes = saved.panes.map((p) => ({ ...p, id: newPaneId() }));
      const focusedIndex = Math.max(0, saved.panes.findIndex((p) => p.id === saved!.focused));
      set({ panes, direction: saved.direction ?? "row", focused: panes[focusedIndex].id, buffers: {} });
      await Promise.all([...new Set(panes.map((p) => p.active).filter((a): a is string => !!a))].map(load));
      // Drop tabs whose files are gone.
      for (const p of get().panes) for (const t of p.tabs) if (get().buffers[t]?.deleted) get().closeTab(p.id, t);
    },

    activePath() {
      const s = get();
      return s.panes.find((p) => p.id === s.focused)?.active ?? null;
    },
  };
});

// Persist the layout per vault (in the app's own storage, never in the vault).
useWorkspace.subscribe((s, prev) => {
  if (!layoutRoot || (s.panes === prev.panes && s.direction === prev.direction && s.focused === prev.focused)) return;
  try {
    localStorage.setItem(
      `mosaic:layout:${layoutRoot}`,
      JSON.stringify({ version: 2, panes: s.panes, direction: s.direction, focused: s.focused }),
    );
  } catch {
    // Storage unavailable: layout just isn't remembered.
  }
});
