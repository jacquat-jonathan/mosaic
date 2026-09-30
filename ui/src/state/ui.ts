// Transient UI: context menu, confirm dialog, toasts. In-app dialogs only — native alert/confirm block
// the webview.

import { create } from "zustand";

export interface MenuItem {
  label: string;
  action?: () => void;
  danger?: boolean;
  separator?: boolean;
  shortcut?: string;
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

export type SidebarTab = "files" | "search" | "tags";

interface UiState {
  sidebarTab: SidebarTab;
  searchQuery: string;
  /** Bumped to focus the search box. */
  searchFocus: number;
  switcher: boolean;
  rightPanel: boolean;
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

export const useUi = create<UiState>((set, get) => ({
  sidebarTab: "files",
  searchQuery: "",
  searchFocus: 0,
  switcher: false,
  rightPanel: true,
  setSidebarTab: (sidebarTab) => set({ sidebarTab }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  showSearch: (q) =>
    set((s) => ({ sidebarTab: "search", searchQuery: q ?? s.searchQuery, searchFocus: s.searchFocus + 1 })),
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
