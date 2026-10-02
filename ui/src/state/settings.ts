// App preferences shown in Settings. They live in the app's own storage (never the vault) and apply
// immediately.

import { create } from "zustand";
import { inTauri } from "../ipc/api";

export type Theme = "system" | "light" | "dark";

export interface Prefs {
  theme: Theme;
  /** Note text size in px. */
  noteSize: number;
  /** Keep notes to a comfortable line length instead of the full pane width. */
  readableWidth: boolean;
  spellcheck: boolean;
  /** Where ⌘N and the "New note" button put new notes. */
  newNoteLocation: "root" | "current";
  /** Ask before moving files to the Trash. */
  confirmTrash: boolean;
  /** Folder for daily notes (vault-relative, "" = root). */
  dailyFolder: string;
  /** Note copied into each new daily note, with {{date}}, {{title}}, {{weekday}}, {{time}} filled in. */
  dailyTemplate: string;
  /** Shortcuts changed in Settings › Shortcuts: command id → keys, or null for "no shortcut". */
  shortcuts: Record<string, ShortcutKeys | null>;
}

/** Same shape as `Keys` in commands.ts (kept here so settings don't import the command registry). */
export interface ShortcutKeys {
  code: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

const isKeys = (v: unknown): v is ShortcutKeys => !!v && typeof v === "object" && typeof (v as ShortcutKeys).code === "string";

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  noteSize: 16,
  readableWidth: true,
  spellcheck: true,
  newNoteLocation: "current",
  confirmTrash: true,
  dailyFolder: "Daily",
  dailyTemplate: "",
  shortcuts: {},
};

export const NOTE_SIZE_MIN = 13;
export const NOTE_SIZE_MAX = 22;
const KEY = "mosaic:settings";

/** Keeps known keys of the right type from stored JSON, falling back to defaults for anything else. */
export function sanitize(raw: unknown): Prefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = <K extends keyof Prefs>(k: K, ok: (v: unknown) => boolean): Prefs[K] => (ok(r[k]) ? (r[k] as Prefs[K]) : DEFAULT_PREFS[k]);
  const size = typeof r.noteSize === "number" ? Math.round(Math.min(NOTE_SIZE_MAX, Math.max(NOTE_SIZE_MIN, r.noteSize))) : DEFAULT_PREFS.noteSize;
  return {
    theme: pick("theme", (v) => v === "system" || v === "light" || v === "dark"),
    noteSize: size,
    readableWidth: pick("readableWidth", (v) => typeof v === "boolean"),
    spellcheck: pick("spellcheck", (v) => typeof v === "boolean"),
    newNoteLocation: pick("newNoteLocation", (v) => v === "root" || v === "current"),
    confirmTrash: pick("confirmTrash", (v) => typeof v === "boolean"),
    dailyFolder: pick("dailyFolder", (v) => typeof v === "string"),
    dailyTemplate: pick("dailyTemplate", (v) => typeof v === "string"),
    shortcuts:
      r.shortcuts && typeof r.shortcuts === "object"
        ? Object.fromEntries(Object.entries(r.shortcuts as Record<string, unknown>).filter(([, v]) => v === null || isKeys(v))) as Prefs["shortcuts"]
        : {},
  };
}

function load(): Prefs {
  try {
    return sanitize(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return DEFAULT_PREFS;
  }
}

interface SettingsState extends Prefs {
  set<K extends keyof Prefs>(key: K, value: Prefs[K]): void;
  reset(): void;
}

export const useSettings = create<SettingsState>((set) => ({
  ...load(),
  set: (key, value) => set({ [key]: value } as Partial<Prefs>),
  reset: () => set(DEFAULT_PREFS),
}));

export function prefs(): Prefs {
  return sanitize(useSettings.getState());
}

/** Pushes preferences into the page: theme attribute, CSS variables, native window appearance. */
export function applyPrefs(p: Prefs) {
  if (typeof document === "undefined") return; // unit tests run without a page
  const root = document.documentElement;
  if (p.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = p.theme;
  root.style.setProperty("--note-size", `${p.noteSize}px`);
  root.style.setProperty("--note-width", p.readableWidth ? "760px" : "none");
  if (inTauri) {
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      getCurrentWindow()
        .setTheme(p.theme === "system" ? null : p.theme)
        .catch(() => {}),
    );
  }
  window.dispatchEvent(new Event("mosaic-theme"));
}

applyPrefs(prefs());
useSettings.subscribe((s) => {
  const p = sanitize(s);
  applyPrefs(p);
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Storage unavailable: preferences last until the app quits.
  }
});
