// The effective colour scheme: the Settings choice, or the system's when set to "System".

import { useSyncExternalStore } from "react";

export function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t === "dark") return true;
  if (t === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** Whether the High contrast palette is active (colorThemes.ts sets `data-color-theme` on <html>). */
export function isHighContrast(): boolean {
  return document.documentElement.dataset.colorTheme === "high-contrast";
}

/** What diagrams bake into their SVG: the scheme, and whether High contrast is on. */
export type VisualTheme = "light" | "dark" | "high-contrast-light" | "high-contrast-dark";
export function visualTheme(): VisualTheme {
  const scheme = isDark() ? "dark" : "light";
  return isHighContrast() ? `high-contrast-${scheme}` : scheme;
}

/** Calls `cb` whenever the effective scheme flips: a Settings change, or the system's when set to "System". */
export function onDarkChange(cb: (dark: boolean) => void): () => void {
  return watch(isDark, cb);
}

/** Calls `cb` whenever the scheme flips or High contrast is turned on or off. */
export function onVisualThemeChange(cb: (theme: VisualTheme) => void): () => void {
  return watch(visualTheme, cb);
}

function watch<T>(read: () => T, cb: (value: T) => void): () => void {
  let last = read();
  const check = () => {
    const now = read();
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

/** `visualTheme()` as React state, so diagrams redraw for the scheme and for High contrast. */
export function useVisualTheme(): VisualTheme {
  return useSyncExternalStore(onVisualThemeChange, visualTheme);
}
