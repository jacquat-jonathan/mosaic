// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import type { Entry } from "../ipc/types";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { BookmarksPanel, reorder } from "./BookmarksPanel";
import { Picker, filterItems } from "./Picker";
import { QuickSwitcher, fuzzyScore } from "./QuickSwitcher";

const entry = (path: string, is_dir = false, mtime = 1): Entry => ({
  path,
  name: path.split("/").at(-1)!,
  is_dir,
  kind: is_dir ? null : "markdown",
  size: 10,
  mtime,
});

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  useUi.setState({ picker: null, switcher: false, menu: null, searchQuery: "", sidebarTab: "search" });
  useVault.setState({
    entries: [entry("Folder", true), entry("Folder/Plan.md", false, 3), entry("Ideas.md", false, 2)],
    bookmarks: [],
    aliases: [],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("bookmark helpers and panel cover files, folders, searches, queries and missing targets", async () => {
  expect(reorder(["a", "b", "c"], 0, 2)).toEqual(["b", "a", "c"]);
  expect(reorder(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  const setBookmarks = vi.spyOn(api, "setBookmarks").mockResolvedValue(null);
  const toggleBookmark = vi.fn(async () => {});
  useVault.setState({
    bookmarks: ["Folder", "Folder/Plan.md", "Missing.md", "search:release", "query:task:open"],
    toggleBookmark,
  });
  const open = vi.spyOn(useWorkspace.getState(), "open").mockResolvedValue();
  render(<BookmarksPanel />);

  fireEvent.click(screen.getByTitle("Folder/Plan.md"));
  expect(open).toHaveBeenCalledWith("Folder/Plan.md");
  await waitFor(() => expect(screen.getByRole("group", { name: "Bookmarks" }).getAttribute("aria-busy")).toBe("false"));
  fireEvent.click(screen.getByTitle("Folder/Plan.md"), { altKey: true });
  expect(open).toHaveBeenCalledWith("Folder/Plan.md", { newTab: true });
  await waitFor(() => expect(screen.getByRole("group", { name: "Bookmarks" }).getAttribute("aria-busy")).toBe("false"));
  fireEvent.contextMenu(screen.getByTitle("Folder/Plan.md"), { clientX: 4, clientY: 8 });
  expect(useUi.getState().menu?.items.some((item) => item.label === "Open to the right")).toBe(true);
  fireEvent.contextMenu(screen.getByTitle(/Missing.md/));
  expect(useUi.getState().menu?.items.filter((item) => item.label === "Remove bookmark")).toHaveLength(1);
  fireEvent.click(screen.getByTitle("Search: release"));
  expect(useUi.getState().searchQuery).toBe("release");
  fireEvent.click(screen.getByTitle("Query: task:open"));
  expect(open).toHaveBeenCalledWith("mosaic:query/task%3Aopen");
  await waitFor(() => expect(screen.getByRole("group", { name: "Bookmarks" }).getAttribute("aria-busy")).toBe("false"));

  const transfer = {
    data: new Map<string, string>(),
    types: ["application/x-mosaic-bookmark"],
    effectAllowed: "none",
    setData(type: string, value: string) {
      this.data.set(type, value);
    },
    getData(type: string) {
      return this.data.get(type) ?? "";
    },
  };
  const file = screen.getByTitle("Folder/Plan.md");
  fireEvent.dragStart(file, { dataTransfer: transfer });
  fireEvent.dragOver(screen.getByTitle("Search: release"), { dataTransfer: transfer });
  fireEvent.drop(screen.getByTitle("Search: release"), { dataTransfer: transfer });
  expect(setBookmarks).toHaveBeenCalled();
});

test("bookmark panel saves a validated structured query", async () => {
  vi.spyOn(useUi.getState(), "askText").mockResolvedValue("  task:open  ");
  vi.spyOn(api, "query").mockResolvedValue({ columns: [], rows: [], total: 0 });
  const setBookmarks = vi.spyOn(api, "setBookmarks").mockResolvedValue(null);
  useVault.setState({ bookmarks: [] });
  render(<BookmarksPanel />);
  await userEvent.click(screen.getByRole("button", { name: /Save query/ }));
  await waitFor(() => expect(setBookmarks).toHaveBeenCalledWith(["query:task:open"]));
});

test("bookmark writes serialize, retain saved order on failure and ignore foreign drops", async () => {
  let reject!: (reason: Error) => void;
  const write = vi.spyOn(api, "setBookmarks").mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  useVault.setState({ bookmarks: ["Ideas.md", "Folder/Plan.md"] });
  render(<BookmarksPanel />);
  const ideas = screen.getByTitle("Ideas.md");
  fireEvent.keyDown(ideas, { key: "ArrowDown", altKey: true });
  expect(write).toHaveBeenCalledWith(["Folder/Plan.md", "Ideas.md"]);
  fireEvent.keyDown(ideas, { key: "ArrowDown", altKey: true });
  expect(write).toHaveBeenCalledTimes(1);
  expect(useVault.getState().bookmarks).toEqual(["Ideas.md", "Folder/Plan.md"]);
  await act(async () => reject(new Error("Bookmark write failed")));
  expect(screen.getByRole("alert").textContent).toContain("Bookmark write failed");
  fireEvent.drop(ideas, { dataTransfer: { types: ["text/plain"], getData: () => "0" } });
  expect(write).toHaveBeenCalledTimes(1);
});

test("a delayed saved-query choice cannot change a different vault", async () => {
  let resolve!: (value: string | null) => void;
  vi.spyOn(useUi.getState(), "askText").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const query = vi.spyOn(api, "query").mockResolvedValue({ columns: [], rows: [], total: 0 });
  const write = vi.spyOn(api, "setBookmarks").mockResolvedValue(null);
  useVault.setState({ vault: { root: "/first", name: "First" }, bookmarks: [] });
  const { unmount } = render(<BookmarksPanel />);
  fireEvent.click(screen.getByRole("button", { name: /Save query/ }));
  unmount();
  useVault.setState({ vault: { root: "/second", name: "Second" } });
  await act(async () => resolve("task:open"));
  expect(query).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

test("picker filters, keyboard-selects, reports no matches and closes", async () => {
  expect(filterItems([{ id: "a", label: "Alpha" }], "ph").map((item) => item.id)).toEqual(["a"]);
  expect(filterItems([{ id: "a", label: "Alpha" }], "zzz")).toEqual([]);
  const picked = vi.fn();
  useUi.getState().openPicker({
    placeholder: "Choose a note",
    items: [
      { id: "a", label: "Alpha", detail: "Folder/Alpha.md", shortcut: "⌘1" },
      { id: "b", label: "Beta" },
    ],
    hint: "Pick one",
    onPick: picked,
  });
  render(<Picker />);
  const input = screen.getByPlaceholderText("Choose a note");
  await userEvent.type(input, "a");
  await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  expect(picked).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

  useUi.getState().openPicker({ placeholder: "Nothing", items: [], onPick: picked });
  cleanup();
  render(<Picker />);
  expect(screen.getByText("No matches")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(useUi.getState().picker).toBeNull();
});

test("quick switcher ranks, opens recent and searched files, and closes with escape", async () => {
  expect(fuzzyScore("fb", "fb")).toBeGreaterThan(fuzzyScore("fb", "far below"));
  expect(fuzzyScore("zzz", "Alpha")).toBe(-1);
  const open = vi.spyOn(useWorkspace.getState(), "open").mockResolvedValue();
  useUi.setState({ switcher: true });
  render(<QuickSwitcher />);
  const input = screen.getByPlaceholderText("Find or create a note…");
  await userEvent.type(input, "plan");
  await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  await waitFor(() => expect(open).toHaveBeenCalledWith("Folder/Plan.md", { newTab: false }));

  useUi.setState({ switcher: true });
  cleanup();
  render(<QuickSwitcher />);
  await userEvent.keyboard("{Escape}");
  expect(useUi.getState().switcher).toBe(false);
});
