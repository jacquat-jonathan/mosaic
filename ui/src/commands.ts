// Every app command in one place: the command palette lists them, keyboard shortcuts run them and menus
// show their shortcuts from here.

import { useUi } from "./state/ui";
import { parentOf, useVault } from "./state/vault";
import { useWorkspace } from "./state/workspace";
import { createVault, deletePath, NEW_KINDS, newNote, newNoteDir, newOfKind, openVaultFolder, revealInTree } from "./actions";

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
  keys?: Keys;
  run(): void;
  /** Hidden from the palette (and shortcut ignored) when this returns false. */
  when?(): boolean;
}

const KEY_LABELS: Record<string, string> = { Backslash: "\\", Backspace: "⌫", Comma: ",", Enter: "↵", BracketLeft: "[", BracketRight: "]" };

/** "⌥⇧⌘P"-style label, in the order macOS menus use. */
export function formatKeys(k: Keys): string {
  const key = KEY_LABELS[k.code] ?? (k.code.startsWith("Key") || k.code.startsWith("Digit") ? k.code.slice(-1) : k.code);
  return `${k.alt ? "⌥" : ""}${k.shift ? "⇧" : ""}${k.meta ? "⌘" : ""}${key}`;
}

export function matches(k: Keys, e: Pick<KeyboardEvent, "code" | "metaKey" | "shiftKey" | "altKey" | "ctrlKey">): boolean {
  return e.code === k.code && e.metaKey === !!k.meta && e.shiftKey === !!k.shift && e.altKey === !!k.alt && !e.ctrlKey;
}

const active = () => useWorkspace.getState().activePath();
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
    when: hasActive,
    run: () => useWorkspace.getState().closeTab(useWorkspace.getState().focused, active()!),
  },
  { id: "split-right", label: "Split right", keys: { code: "Backslash", meta: true }, run: () => useWorkspace.getState().split("row") },
  { id: "split-down", label: "Split down", keys: { code: "Backslash", meta: true, shift: true }, run: () => useWorkspace.getState().split("column") },
  { id: "toggle-left", label: "Toggle left sidebar", keys: { code: "KeyL", meta: true, alt: true }, run: () => useUi.getState().toggleLeftSidebar() },
  { id: "toggle-right", label: "Toggle right panel (backlinks, outline)", keys: { code: "KeyB", meta: true, alt: true }, run: () => useUi.getState().toggleRightPanel() },
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

export function shortcutOf(id: string): string | undefined {
  const k = commands().find((c) => c.id === id)?.keys;
  return k && formatKeys(k);
}

export function openPalette() {
  const ui = useUi.getState();
  if (ui.picker) return ui.closePicker();
  const available = commands().filter((c) => c.id !== "palette" && (c.when?.() ?? true));
  ui.openPicker({
    placeholder: "Type a command…",
    items: available.map((c) => ({ id: c.id, label: c.label, shortcut: c.keys && formatKeys(c.keys) })),
    hint: "↵ run · esc close",
    onPick: (item) => commands().find((c) => c.id === item.id)?.run(),
  });
}
