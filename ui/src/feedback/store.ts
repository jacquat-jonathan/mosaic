import { create } from "zustand";

/**
 * Whether the feedback dialog is open. Any entry point (the sidebar footer, a menu item) opens the same dialog.
 * An entry point that is a control passes itself as `returnFocus`: WebKit doesn't focus buttons on click, so
 * the focused element at open time can't be relied on to bring focus back.
 */
export const useFeedback = create<{
  open: boolean;
  returnFocus: HTMLElement | null;
  show(returnFocus?: HTMLElement | null): void;
  hide(): void;
}>((set) => ({
  open: false,
  returnFocus: null,
  show: (returnFocus = null) => set({ open: true, returnFocus }),
  hide: () => set({ open: false, returnFocus: null }),
}));
