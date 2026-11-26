// @vitest-environment jsdom
// "Show hidden files and folders": listing, view-only opening and bounded change handling.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "./ipc/api";
import type { Entry } from "./ipc/types";
import { HIDDEN_FILES_OFF, isHiddenPath } from "./hidden";
import { hiddenFoldersToRelist, HIDDEN_RELIST_MS, startVaultSync } from "./sync";
import { useVault, withHiddenChildren } from "./state/vault";
import { DEFAULT_VAULT_PREFS, useVaultPreferences } from "./state/vaultPreferences";
import { useWorkspace } from "./state/workspace";

const ROOT = "/mock/vault";
const e = (path: string, is_dir = false): Entry => ({
  path,
  name: path.split("/").pop()!,
  is_dir,
  kind: is_dir ? null : "text",
  size: 1,
  mtime: 0,
});
const paths = (entries: Entry[]) => entries.map((x) => x.path);

async function showHidden(on: boolean) {
  await api.setVaultPreferences(ROOT, { show_hidden_files: on });
  useVaultPreferences.setState({ root: ROOT, value: { ...DEFAULT_VAULT_PREFS, show_hidden_files: on }, error: null });
}

beforeEach(async () => {
  await showHidden(false);
  useVault.setState({ entries: [], hiddenEntries: [], expanded: new Set(), selected: new Set() });
  useWorkspace.setState({ panes: [{ id: "p", tabs: [], active: null }], focused: "p", buffers: {}, direction: "row" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("hidden paths are the ones with a dot-prefixed segment", () => {
  expect(isHiddenPath(".claude/settings.json")).toBe(true);
  expect(isHiddenPath("a/.github")).toBe(true);
  expect(isHiddenPath("Notes/a.md")).toBe(false);
});

test("the tree lists hidden entries only while the setting is on, apart from ordinary entries", async () => {
  await useVault.getState().refresh();
  expect(useVault.getState().hiddenEntries).toEqual([]);
  expect(paths(useVault.getState().entries).some(isHiddenPath)).toBe(false);

  await showHidden(true);
  await useVault.getState().refresh();
  const { entries, hiddenEntries } = useVault.getState();
  expect(paths(entries).some(isHiddenPath)).toBe(false);
  // Hidden folders aren't walked into, and .git / .mosaic never appear.
  expect(paths(hiddenEntries).sort()).toEqual([".claude", ".gitignore"]);

  // Opening a hidden folder lists its children on demand.
  useVault.getState().toggle(".claude", true);
  await vi.waitFor(() => expect(paths(useVault.getState().hiddenEntries)).toContain(".claude/settings.json"));
  expect(paths(useVault.getState().hiddenEntries)).toContain(".claude/commands");
  // A refresh keeps the open folder's children.
  await useVault.getState().refresh();
  expect(paths(useVault.getState().hiddenEntries)).toContain(".claude/settings.json");

  await showHidden(false);
  await useVault.getState().refresh();
  expect(useVault.getState().hiddenEntries).toEqual([]);
});

test("turning the setting on or off reloads the tree", async () => {
  const stop = await startVaultSync();
  const refresh = vi.spyOn(useVault.getState(), "refresh");
  try {
    useVaultPreferences.setState({ value: { ...DEFAULT_VAULT_PREFS, show_hidden_files: true } });
    expect(refresh).toHaveBeenCalledTimes(1);
    useVaultPreferences.setState({
      value: { ...DEFAULT_VAULT_PREFS, show_hidden_files: true, link_style: "markdown" },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally {
    stop();
  }
});

test("a hidden file opens view-only, and explains itself when the setting is off", async () => {
  const ws = () => useWorkspace.getState();
  await ws().open(".claude/settings.json");
  expect(ws().buffers[".claude/settings.json"]).toMatchObject({
    readOnly: true,
    content: null,
    error: HIDDEN_FILES_OFF,
  });
  useWorkspace.setState({ panes: [{ id: "p", tabs: [], active: null }], buffers: {} });

  await showHidden(true);
  await ws().open(".claude/settings.json");
  const buffer = ws().buffers[".claude/settings.json"];
  expect(buffer).toMatchObject({ readOnly: true, kind: "json", error: null });
  expect(buffer.content).toContain("permissions");
  // Dotfiles without a known extension read as text.
  await ws().open(".gitignore");
  expect(ws().buffers[".gitignore"]).toMatchObject({ kind: "text", readOnly: true });

  const write = vi.spyOn(api, "write");
  ws().edit(".gitignore", "changed");
  await ws().save(".gitignore");
  expect(ws().buffers[".gitignore"].dirty).toBe(false);
  expect(write).not.toHaveBeenCalled();
});

test("re-listing a folder replaces its hidden children and whatever was inside them", () => {
  const hidden = [
    e(".claude", true),
    e(".claude/skills", true),
    e(".claude/skills/a.md"),
    e("a/.github", true),
    e("a/b/.x"),
  ];
  expect(paths(withHiddenChildren(hidden, "", [e(".vscode", true)]))).toEqual(["a/.github", "a/b/.x", ".vscode"]);
  expect(paths(withHiddenChildren(hidden, "a", []))).toEqual([
    ".claude",
    ".claude/skills",
    ".claude/skills/a.md",
    "a/b/.x",
  ]);
  // The re-listed folder itself stays; only what was inside it is replaced.
  expect(paths(withHiddenChildren(hidden, ".claude", [e(".claude/settings.json")]))).toEqual([
    ".claude",
    "a/.github",
    "a/b/.x",
    ".claude/settings.json",
  ]);
});

test("changes inside a closed hidden folder cost nothing; open ones are re-listed", () => {
  const hidden = [e(".next", true), e(".next/cache", true), e(".claude", true)];
  // A churning, closed .next: nothing to list.
  expect(hiddenFoldersToRelist([".next/cache/x.json", ".next/cache/y/z"], hidden, new Set())).toEqual([]);
  // .next/cache was opened once, but .next is closed now: still nothing.
  expect(hiddenFoldersToRelist([".next/cache/x.json"], hidden, new Set([".next/cache"]))).toEqual([]);
  expect(hiddenFoldersToRelist([".next/cache/x.json"], hidden, new Set([".next", ".next/cache"]))).toEqual([
    ".next/cache",
  ]);
  // A hidden entry appearing in an ordinary folder re-lists that folder.
  expect(hiddenFoldersToRelist([".vscode", "Notes/.obsidian"], hidden, new Set())).toEqual(["", "Notes"]);
});

test("hidden changes never reload the whole tree and are re-listed at most once a second", async () => {
  vi.useFakeTimers();
  await showHidden(true);
  useVault.setState({ hiddenEntries: [e(".claude", true)], expanded: new Set([".claude"]) });
  const refresh = vi.spyOn(useVault.getState(), "refresh");
  const refreshHidden = vi.spyOn(useVault.getState(), "refreshHidden").mockResolvedValue();
  const stop = await startVaultSync();
  const emit = (hidden_paths: string[]) =>
    window.dispatchEvent(
      new CustomEvent("mock-vault-changed", { detail: { paths: [], hidden_paths, root_missing: false } }),
    );
  try {
    for (let i = 0; i < 20; i++) {
      emit([`.claude/file-${i}.json`, `.next/cache/${i}`]);
      vi.advanceTimersByTime(100);
    }
    expect(refresh).not.toHaveBeenCalled();
    // 2 s of events every 100 ms: two re-listings of the one open folder.
    expect(refreshHidden).toHaveBeenCalledTimes(Math.floor(2000 / HIDDEN_RELIST_MS));
    expect(refreshHidden).toHaveBeenLastCalledWith([".claude"]);
  } finally {
    stop();
  }
});
