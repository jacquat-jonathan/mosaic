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

interface Confirm {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  resolve(ok: boolean): void;
}

interface UiState {
  menu: { x: number; y: number; items: MenuItem[] } | null;
  confirm: Confirm | null;
  showMenu(x: number, y: number, items: MenuItem[]): void;
  hideMenu(): void;
  ask(opts: Omit<Confirm, "resolve">): Promise<boolean>;
  answer(ok: boolean): void;
}

export const useUi = create<UiState>((set, get) => ({
  menu: null,
  confirm: null,
  showMenu: (x, y, items) => set({ menu: { x, y, items } }),
  hideMenu: () => set({ menu: null }),
  ask: (opts) => new Promise<boolean>((resolve) => set({ confirm: { ...opts, resolve } })),
  answer(ok) {
    get().confirm?.resolve(ok);
    set({ confirm: null });
  },
}));
