// App preferences shown in Settings. They live in the app's own storage (never the vault) and apply
// immediately.

import { create } from "zustand";
import { inTauri } from "../ipc/api";

export type Theme = "system" | "light" | "dark";

export type NoteWidth = "narrow" | "medium" | "wide" | "full";
/** Max width of a note's text column, per setting. */
export const NOTE_WIDTHS: Record<NoteWidth, string> = { narrow: "640px", medium: "760px", wide: "1040px", full: "none" };

export interface Prefs {
  noteFont: string;
  codeFont: string;
  lineSpacing: number;
  headingScale: number;
  accent: "blue" | "green" | "violet" | "amber";
  uiScale: number;
  density: "comfortable" | "compact";
  sourceLineNumbers: boolean;
  weekStart: "monday" | "sunday";
  openLinksNewTab: boolean;
  startup: "restore" | "today" | "note";
  sidebarVisible: boolean;
  sidebarWidth: number;
  contextVisible: boolean;
  contextWidth: number;
  theme: Theme;
  /** Note text size in px. */
  noteSize: number;
  /** How wide notes may get: a comfortable line length, or the full pane. */
  noteWidth: NoteWidth;
  spellcheck: boolean;
  /** Where ⌘N and the "New note" button put new notes. */
  newNoteLocation: "root" | "current";
  /** Ask before moving files to the Trash. */
  confirmTrash: boolean;
  /** Folder for daily notes (vault-relative, "" = root). */
  dailyFolder: string;
  /** Note copied into each new daily note, with {{date}}, {{title}}, {{weekday}}, {{time}} filled in. */
  dailyTemplate: string;
  /** Claude Code model alias for chat; empty lets Claude Code choose its default. */
  chatModel: "" | "sonnet" | "opus" | "haiku";
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
  noteFont: "system", codeFont: "system", lineSpacing: 1.7, headingScale: 1,
  accent: "blue", uiScale: 1, density: "comfortable", sourceLineNumbers: false,
  weekStart: "monday", openLinksNewTab: false, startup: "restore",
  sidebarVisible: true, sidebarWidth: 260, contextVisible: true, contextWidth: 280,
  theme: "system",
  noteSize: 16,
  noteWidth: "medium",
  spellcheck: true,
  newNoteLocation: "current",
  confirmTrash: true,
  dailyFolder: "Daily",
  dailyTemplate: "",
  chatModel: "",
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
    noteFont: pick("noteFont", v => typeof v === "string" && v.length > 0 && v.length <= 100),
    codeFont: pick("codeFont", v => typeof v === "string" && v.length > 0 && v.length <= 100),
    lineSpacing: pick("lineSpacing", v => typeof v === "number" && v >= 1.3 && v <= 2.2),
    headingScale: pick("headingScale", v => typeof v === "number" && v >= 0.85 && v <= 1.3),
    accent: pick("accent", v => ["blue", "green", "violet", "amber"].includes(String(v))),
    uiScale: pick("uiScale", v => typeof v === "number" && v >= 0.85 && v <= 1.3),
    density: pick("density", v => v === "comfortable" || v === "compact"),
    sourceLineNumbers: pick("sourceLineNumbers", v => typeof v === "boolean"),
    weekStart: pick("weekStart", v => v === "monday" || v === "sunday"),
    openLinksNewTab: pick("openLinksNewTab", v => typeof v === "boolean"),
    startup: pick("startup", v => ["restore", "today", "note"].includes(String(v))),
    sidebarVisible: pick("sidebarVisible", v => typeof v === "boolean"),
    contextVisible: pick("contextVisible", v => typeof v === "boolean"),
    sidebarWidth: pick("sidebarWidth", v => typeof v === "number" && v >= 180 && v <= 600),
    contextWidth: pick("contextWidth", v => typeof v === "number" && v >= 180 && v <= 600),
    theme: pick("theme", (v) => v === "system" || v === "light" || v === "dark"),
    noteSize: size,
    // Before 0.9.2 this was an on/off "readable line width": off means full width.
    noteWidth: typeof r.noteWidth === "string" && r.noteWidth in NOTE_WIDTHS ? (r.noteWidth as NoteWidth) : r.readableWidth === false ? "full" : DEFAULT_PREFS.noteWidth,
    spellcheck: pick("spellcheck", (v) => typeof v === "boolean"),
    newNoteLocation: pick("newNoteLocation", (v) => v === "root" || v === "current"),
    confirmTrash: pick("confirmTrash", (v) => typeof v === "boolean"),
    dailyFolder: pick("dailyFolder", (v) => typeof v === "string"),
    dailyTemplate: pick("dailyTemplate", (v) => typeof v === "string"),
    chatModel: pick("chatModel", (v) => v === "" || v === "sonnet" || v === "opus" || v === "haiku"),
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

function persistPatch(patch: Partial<Prefs>) {
  try { const existing = JSON.parse(localStorage.getItem(KEY) ?? "{}"); localStorage.setItem(KEY, JSON.stringify({ ...existing, ...patch })); } catch { /* Storage unavailable; live preferences still apply. */ }
}
export const useSettings = create<SettingsState>((set) => ({
  ...load(),
  set: (key, value) => { persistPatch({ [key]: value }); set({ [key]: value } as Partial<Prefs>); },
  reset: () => { persistPatch(DEFAULT_PREFS); set(DEFAULT_PREFS); },
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
  root.style.setProperty("--note-width", NOTE_WIDTHS[p.noteWidth]);
  root.style.setProperty("--font-text", p.noteFont === "system" ? ' -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif' : `${JSON.stringify(p.noteFont)}, -apple-system, sans-serif`);
  root.style.setProperty("--font-mono", p.codeFont === "system" ? '"SF Mono", ui-monospace, Menlo, monospace' : `${JSON.stringify(p.codeFont)}, ui-monospace, Menlo, monospace`);
  root.style.setProperty("--note-leading", String(p.lineSpacing));
  root.style.setProperty("--heading-scale", String(p.headingScale));
  root.style.zoom = String(p.uiScale);
  root.dataset.density = p.density;
  root.dataset.accent = p.accent;
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
useSettings.subscribe((s, previous) => {
  const p = sanitize(s);
  applyPrefs(p);
  try {
    const patch = Object.fromEntries(Object.entries(p).filter(([key, value]) => JSON.stringify(previous[key as keyof Prefs]) !== JSON.stringify(value)));
    persistPatch(patch);
  } catch {
    // Storage unavailable: preferences last until the app quits.
  }
});
