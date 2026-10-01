// The effective colour scheme: the Settings choice, or the system's when set to "System".

import { useSyncExternalStore } from "react";

export function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t === "dark") return true;
  if (t === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** Calls `cb` whenever the effective scheme flips: a Settings change, or the system's when set to "System". */
export function onDarkChange(cb: (dark: boolean) => void): () => void {
  let last = isDark();
  const check = () => {
    const now = isDark();
    if (now === last) return;
    last = now;
    cb(now);
  };
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  window.addEventListener("mosaic-theme", check);
  media?.addEventListener("change", check);
  return () => {
    window.removeEventListener("mosaic-theme", check);
    media?.removeEventListener("change", check);
  };
}

/** `isDark()` as React state, so visuals redraw when the theme changes. */
export function useDark(): boolean {
  return useSyncExternalStore(onDarkChange, isDark);
}
