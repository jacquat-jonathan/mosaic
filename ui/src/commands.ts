// Every app command in one place: the command palette lists them, keyboard shortcuts run them and menus
// show their shortcuts from here.

import { useUi } from "./state/ui";
import { addProperty } from "./editor/noteViews";
import { parentOf, useVault } from "./state/vault";
import { useWorkspace } from "./state/workspace";
import { createVault, deletePath, pickFolderAndMove, NEW_KINDS, newNote, newNoteDir, newOfKind, openCalendar, openDailyNote, openVaultFolder, revealInTree } from "./actions";
import { isSpecialTab } from "./views/specialTabs";
import { prefs } from "./state/settings";

/** A shortcut: `code` is `KeyboardEvent.code` (layout- and ⌥-independent), e.g. "KeyP" or "Backslash". */
export interface Keys {
  code: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface Command {
  id: string;
  label: string;
  /** The default shortcut; what applies is `keysFor(command)` (Settings › Shortcuts can change it). */
  keys?: Keys;
  run(): void;
  /** Hidden from the palette (and shortcut ignored) when this returns false. */
  when?(): boolean;
}

const KEY_LABELS: Record<string, string> = { Semicolon: ";", Backslash: "\\", Backspace: "⌫", Comma: ",", Enter: "↵", BracketLeft: "[", BracketRight: "]" };

/** "⌥⇧⌘P"-style label, in the order macOS menus use. */
export function formatKeys(k: Keys): string {
  const key = KEY_LABELS[k.code] ?? (k.code.startsWith("Key") || k.code.startsWith("Digit") ? k.code.slice(-1) : k.code);
  return `${k.alt ? "⌥" : ""}${k.shift ? "⇧" : ""}${k.meta ? "⌘" : ""}${key}`;
}

export function matches(k: Keys, e: Pick<KeyboardEvent, "code" | "metaKey" | "shiftKey" | "altKey" | "ctrlKey">): boolean {
  return e.code === k.code && e.metaKey === !!k.meta && e.shiftKey === !!k.shift && e.altKey === !!k.alt && !e.ctrlKey;
}

// The active file (not a view such as the calendar).
const active = () => {
  const p = useWorkspace.getState().activePath();
  return p && !isSpecialTab(p) ? p : null;
};
const activeDir = () => {
  const a = active();
  return a ? parentOf(a) : "";
};
const hasActive = () => active() !== null;

let registry: Command[] | null = null;

/** Built on first use, so modules that import each other can all load before the list is made. */
export function commands(): Command[] {
  return (registry ??= buildCommands());
}

const buildCommands = (): Command[] => [
  { id: "palette", label: "Open command palette", keys: { code: "KeyP", meta: true }, run: () => openPalette() },
  { id: "switcher", label: "Quick switcher: open a file", keys: { code: "KeyO", meta: true }, run: () => useUi.getState().setSwitcher(true) },
  { id: "search", label: "Search in all files", keys: { code: "KeyF", meta: true, shift: true }, run: () => useUi.getState().showSearch() },
  { id: "new-note", label: "New note", keys: { code: "KeyN", meta: true }, run: () => void newNote(newNoteDir()) },
  ...NEW_KINDS.filter((k) => k.ext !== "md").map<Command>((k) => ({
    id: `new-${k.ext}`,
    label: k.label,
    run: () => void newOfKind(activeDir(), k),
  })),
  { id: "new-folder", label: "New folder", keys: { code: "KeyN", meta: true, shift: true }, run: () => void useVault.getState().newFolder(activeDir()) },
  { id: "calendar", label: "Open calendar", run: () => openCalendar() },
  { id: "chat", label: "Chat with Claude", keys: { code: "KeyL", meta: true, shift: true }, run: () => useUi.getState().showChat() },
  {
    id: "add-property",
    label: "Add a property to this note",
    keys: { code: "Semicolon", meta: true },
    when: () => !!active()?.toLowerCase().endsWith(".md"),
    run: () => {
      useUi.setState({ rightPanel: true });
      void addProperty(active()!);
    },
  },
  { id: "daily-note", label: "Open today's daily note", keys: { code: "KeyD", meta: true, shift: true }, run: () => void openDailyNote() },
  {
    id: "export-html",
    label: "Export current note as HTML",
    when: () => active()?.toLowerCase().endsWith(".md") ?? false,
    run: () => void import("./export/note").then((m) => m.exportNoteHtml(active()!)),
  },
  {
    id: "export-pdf",
    label: "Export current note as PDF (print)…",
    keys: { code: "KeyP", meta: true, shift: true },
    when: () => active()?.toLowerCase().endsWith(".md") ?? false,
    run: () => void import("./export/note").then((m) => m.printNote(active()!)),
  },
  {
    id: "file-history",
    label: "Show file history",
    when: hasActive,
    run: () => useUi.getState().openHistory(active()!),
  },
  {
    id: "save",
    label: "Save current file",
    keys: { code: "KeyS", meta: true },
    when: hasActive,
    run: () => void useWorkspace.getState().save(active()!),
  },
  {
    id: "close-tab",
    label: "Close current tab",
    keys: { code: "KeyW", meta: true },
    when: () => !!useWorkspace.getState().activePath(),
    run: () => useWorkspace.getState().closeTab(useWorkspace.getState().focused, useWorkspace.getState().activePath()!),
  },
  { id: "split-right", label: "Split right", keys: { code: "Backslash", meta: true }, run: () => useWorkspace.getState().split("row") },
  { id: "split-down", label: "Split down", keys: { code: "Backslash", meta: true, shift: true }, run: () => useWorkspace.getState().split("column") },
  { id: "toggle-left", label: "Toggle left sidebar", keys: { code: "KeyL", meta: true, alt: true }, run: () => useUi.getState().toggleLeftSidebar() },
  { id: "toggle-right", label: "Toggle right context panel", keys: { code: "KeyB", meta: true, alt: true }, run: () => useUi.getState().toggleRightPanel() },
  ...(["notes", "find", "plan", "ai"] as const).map((destination, i) => ({ id: `destination-${destination}`, label: `Go to ${destination}`, keys: { code: `Digit${i+1}`, meta: true }, run: () => useUi.getState().selectDestination(destination) })),
  ...["chats", "agents", "workflows", "runs", "activity", "connections", "tasks", "today", "week", "overdue"].map(kind => ({ id: `open-${kind}`, label: `Open ${kind}`, run: () => useUi.getState().openView(kind) })),
  { id: "create-workflow", label: "Create workflow", run: () => useUi.getState().openView("new-workflow") },
  { id: "move-file", label: "Move current file…", when: hasActive, run: () => pickFolderAndMove([active()!]) },
  { id: "show-files", label: "Show files", run: () => useUi.getState().setSidebarTab("files") },
  { id: "show-bookmarks", label: "Show bookmarks", run: () => useUi.getState().setSidebarTab("bookmarks") },
  { id: "show-tags", label: "Show tags", run: () => useUi.getState().setSidebarTab("tags") },
  {
    id: "bookmark",
    label: "Bookmark current file / remove bookmark",
    when: hasActive,
    run: () => void useVault.getState().toggleBookmark(active()!),
  },
  { id: "reveal", label: "Reveal current file in the file tree", when: hasActive, run: () => revealInTree(active()!) },
  {
    id: "rename",
    label: "Rename current file",
    when: hasActive,
    run: () => {
      revealInTree(active()!);
      useVault.getState().setRenaming(active()!);
    },
  },
  { id: "delete", label: "Move current file to the Trash", when: hasActive, run: () => void deletePath(active()!, false) },
  { id: "open-vault", label: "Open another vault…", run: () => void openVaultFolder() },
  { id: "create-vault", label: "Create new vault…", run: () => void createVault() },
  { id: "settings", label: "Open settings", keys: { code: "Comma", meta: true }, run: () => useUi.getState().openSettings() },
  { id: "check-updates", label: "Check for updates", run: () => useUi.getState().openSettings("about") },
  { id: "shortcuts", label: "Show keyboard shortcuts", run: () => useUi.getState().openSettings("shortcuts") },
  { id: "connect-ai", label: "Connect AI (MCP / CLI)", run: () => useUi.getState().openSettings("ai") },
];

/** The shortcut that applies to a command: the user's choice in Settings › Shortcuts, or the default. */
export function keysFor(c: Command): Keys | undefined {
  const custom = prefs().shortcuts[c.id];
  return custom === undefined ? c.keys : (custom ?? undefined);
}

export const sameKeys = (a: Keys, b: Keys) => a.code === b.code && !!a.meta === !!b.meta && !!a.shift === !!b.shift && !!a.alt === !!b.alt;

/**
 * Gives `id` the shortcut `keys` (null = none). A command that had the same keys loses them; its
 * label is returned so Settings can say so.
 */
export function rebind(id: string, keys: Keys | null): { shortcuts: Record<string, Keys | null>; tookFrom?: string } {
  const shortcuts = { ...prefs().shortcuts };
  let tookFrom: string | undefined;
  if (keys) {
    for (const other of commands()) {
      const k = keysFor(other);
      if (other.id !== id && k && sameKeys(k, keys)) {
        shortcuts[other.id] = null;
        tookFrom = other.label;
      }
    }
  }
  const def = commands().find((c) => c.id === id)?.keys;
  // Back to the default: drop the override, so later default changes apply.
  if ((keys && def && sameKeys(keys, def)) || (!keys && !def)) delete shortcuts[id];
  else shortcuts[id] = keys;
  return { shortcuts, tookFrom };
}

export function shortcutOf(id: string): string | undefined {
  const c = commands().find((x) => x.id === id);
  const k = c && keysFor(c);
  return k && formatKeys(k);
}

export function openPalette() {
  const ui = useUi.getState();
  if (ui.picker) return ui.closePicker();
  const available = commands().filter((c) => c.id !== "palette" && (c.when?.() ?? true));
  ui.openPicker({
    placeholder: "Type a command…",
    items: available.map((c) => {
      const k = keysFor(c);
      return { id: c.id, label: c.label, shortcut: k && formatKeys(k) };
    }),
    hint: "↵ run · esc close",
    onPick: (item) => commands().find((c) => c.id === item.id)?.run(),
  });
}
