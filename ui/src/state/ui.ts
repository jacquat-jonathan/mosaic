// Transient UI: context menu, confirm dialog, toasts. In-app dialogs only — native alert/confirm block
// the webview.

import { create } from "zustand";
import { useWorkspace } from "./workspace";
import { useChat } from "./chat";
import { noteSelection } from "../editor/noteViews";
import { isSpecialTab, viewPath } from "../views/specialTabs";

export interface MenuItem {
  label: string;
  action?: () => void;
  danger?: boolean;
  separator?: boolean;
  shortcut?: string;
  /** Shows a submenu on hover instead of running an action. */
  children?: MenuItem[];
  checked?: boolean;
  disabled?: boolean;
  /** Small grey text under the label (e.g. a folder path). */
  detail?: string;
}

export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
  shortcut?: string;
}

/** A fuzzy-filtered list in a modal: the command palette, "Move to…" and similar. */
export interface Picker {
  placeholder: string;
  items: PickerItem[];
  onPick(item: PickerItem): void;
  /** Hint line at the bottom. */
  hint?: string;
}

interface Prompt {
  title: string;
  value: string;
  placeholder?: string;
  resolve(value: string | null): void;
}

interface Confirm {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  resolve(ok: boolean): void;
}

export type SettingsSection = "appearance" | "editor" | "vault" | "ai" | "shortcuts" | "about";

export type SidebarTab = "files" | "search" | "tags" | "bookmarks" | "activity";

export type Destination = "notes" | "find" | "plan" | "ai";

export const SIDEBAR_DEFAULT = 260;
export const RIGHT_DEFAULT = 280;
export const PANEL_MIN = 180;
export const PANEL_MAX = 560;
const PREFS_KEY = "mosaic:ui";

interface Prefs {
  destination: Destination;
  sidebarWidth: number;
  rightWidth: number;
  leftSidebar: boolean;
  rightPanel: boolean;
}

export const clampPanel = (w: number) => Math.round(Math.max(PANEL_MIN, Math.min(PANEL_MAX, w)));

function loadPrefs(): Prefs {
  const d: Prefs = { destination: "notes", sidebarWidth: SIDEBAR_DEFAULT, rightWidth: RIGHT_DEFAULT, leftSidebar: true, rightPanel: true };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<Prefs> | null;
    if (!saved) return d;
    return {
      destination: ["notes", "find", "plan", "ai"].includes(saved.destination ?? "") ? saved.destination! : d.destination,
      sidebarWidth: typeof saved.sidebarWidth === "number" ? clampPanel(saved.sidebarWidth) : d.sidebarWidth,
      rightWidth: typeof saved.rightWidth === "number" ? clampPanel(saved.rightWidth) : d.rightWidth,
      leftSidebar: saved.leftSidebar ?? d.leftSidebar,
      rightPanel: saved.rightPanel ?? d.rightPanel,
    };
  } catch {
    return d;
  }
}

interface UiState {
  destination: Destination;
  selectDestination(destination: Destination): void;
  openView(kind: string, id?: string): void;
  sidebarTab: SidebarTab;
  searchQuery: string;
  /** Bumped to focus the search box. */
  searchFocus: number;
  switcher: boolean;
  /** Open Settings section, or null when Settings is closed. */
  settings: SettingsSection | null;
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  /** The file whose history is shown (and the version to select), or null. */
  history: { path: string; focus?: number } | null;
  openHistory(path: string, focus?: number): void;
  closeHistory(): void;
  showChat(): void;
  rightPanel: boolean;
  leftSidebar: boolean;
  sidebarWidth: number;
  rightWidth: number;
  setSidebarWidth(w: number): void;
  setRightWidth(w: number): void;
  toggleLeftSidebar(): void;
  picker: Picker | null;
  openPicker(p: Picker): void;
  closePicker(): void;
  setSidebarTab(tab: SidebarTab): void;
  setSearchQuery(q: string): void;
  showSearch(q?: string): void;
  setSwitcher(open: boolean): void;
  toggleRightPanel(): void;
  menu: { x: number; y: number; items: MenuItem[] } | null;
  confirm: Confirm | null;
  prompt: Prompt | null;
  askText(opts: Omit<Prompt, "resolve">): Promise<string | null>;
  answerText(value: string | null): void;
  showMenu(x: number, y: number, items: MenuItem[]): void;
  hideMenu(): void;
  ask(opts: Omit<Confirm, "resolve">): Promise<boolean>;
  answer(ok: boolean): void;
}

const prefs = loadPrefs();

export const useUi = create<UiState>((set, get) => ({
  destination: prefs.destination,
  selectDestination: (destination) => set((s) => ({ destination, leftSidebar: s.destination === destination ? !s.leftSidebar : true })),
  openView: (kind, id) => { void useWorkspace.getState().open(viewPath(kind, id), { newTab: true }); },
  sidebarTab: "files",
  searchQuery: "",
  searchFocus: 0,
  switcher: false,
  settings: null,
  openSettings: (section = "appearance") => { set({ settings: section, menu: null, picker: null, ...(section === "ai" ? { destination: "ai" as const, leftSidebar: true } : {}) }); get().openView(section === "ai" ? "connections" : "settings"); },
  closeSettings: () => set({ settings: null }),
  history: null,
  openHistory: (path, focus) => set({ history: { path, focus }, menu: null, picker: null }),
  closeHistory: () => set({ history: null }),
  rightPanel: prefs.rightPanel,
  showChat: () => { set({ destination: "ai", leftSidebar: true }); const active = useWorkspace.getState().activePath(); const note = active && !isSpecialTab(active) ? active : null; const id = useChat.getState().create(note ? [note] : []); const selected = note ? noteSelection(note) : null; if (selected && selected.text.length <= 20000) useChat.getState().update(id, { selection: { path: selected.path, text: selected.text } }); get().openView("chat", id); },
  leftSidebar: prefs.leftSidebar,
  sidebarWidth: prefs.sidebarWidth,
  rightWidth: prefs.rightWidth,
  setSidebarWidth: (w) => set({ sidebarWidth: clampPanel(w) }),
  setRightWidth: (w) => set({ rightWidth: clampPanel(w) }),
  toggleLeftSidebar: () => set((s) => ({ leftSidebar: !s.leftSidebar })),
  picker: null,
  openPicker: (picker) => set({ picker, menu: null }),
  closePicker: () => set({ picker: null }),
  setSidebarTab: (sidebarTab) => { set({ sidebarTab, destination: sidebarTab === "files" ? "notes" : sidebarTab === "activity" ? "ai" : "find", leftSidebar: true }); if (sidebarTab === "activity") get().openView("activity"); },
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  showSearch: (q) =>
    set((s) => ({ destination: "find", sidebarTab: "search", leftSidebar: true, searchQuery: q ?? s.searchQuery, searchFocus: s.searchFocus + 1 })),
  setSwitcher: (switcher) => set({ switcher }),
  toggleRightPanel: () => set((s) => ({ rightPanel: !s.rightPanel })),
  menu: null,
  confirm: null,
  prompt: null,
  askText: (opts) => new Promise<string | null>((resolve) => set({ prompt: { ...opts, resolve } })),
  answerText(value) {
    get().prompt?.resolve(value);
    set({ prompt: null });
  },
  showMenu: (x, y, items) => set({ menu: { x, y, items } }),
  hideMenu: () => set({ menu: null }),
  ask: (opts) => new Promise<boolean>((resolve) => set({ confirm: { ...opts, resolve } })),
  answer(ok) {
    get().confirm?.resolve(ok);
    set({ confirm: null });
  },
}));

// Panel sizes and visibility are app preferences (the app's own storage, never the vault).
useUi.subscribe((s, prev) => {
  if (
    s.destination === prev.destination &&
    s.sidebarWidth === prev.sidebarWidth &&
    s.rightWidth === prev.rightWidth &&
    s.leftSidebar === prev.leftSidebar &&
    s.rightPanel === prev.rightPanel
  )
    return;
  try {
    const p: Prefs = { destination: s.destination, sidebarWidth: s.sidebarWidth, rightWidth: s.rightWidth, leftSidebar: s.leftSidebar, rightPanel: s.rightPanel };
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Storage unavailable: sizes just aren't remembered.
  }
});
