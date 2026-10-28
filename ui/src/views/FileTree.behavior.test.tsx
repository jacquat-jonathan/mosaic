// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../ipc/api";
import type { Entry, FileKind } from "../ipc/types";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { DEFAULT_VAULT_PREFS, useVaultPreferences } from "../state/vaultPreferences";
import { useWorkspace } from "../state/workspace";
import { displayName, FileTree, kindIcon } from "./FileTree";

const entry = (path: string, is_dir = false, kind: FileKind = "markdown"): Entry => ({
  path,
  name: path.split("/").pop()!,
  is_dir,
  kind: is_dir ? null : kind,
  size: 10,
  mtime: 1,
});

const entries: Entry[] = [
  entry("Folder", true),
  entry("Folder/Sub", true),
  entry("Folder/Sub/Deep.md"),
  entry("Folder/Note.md"),
  entry("Folder/image.png", false, "image"),
  entry("Other.md"),
  entry("Attachments", true),
  entry("Attachments/quiet.png", false, "image"),
];

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  useVault.setState({
    vault: { root: "/vault", name: "Vault" },
    entries,
    expanded: new Set(["Folder", "Folder/Sub"]),
    selected: new Set(),
    anchor: null,
    cursor: null,
    bookmarks: ["Folder/Note.md"],
    renaming: null,
    error: null,
  });
  useVaultPreferences.setState({
    root: "/vault",
    value: { ...DEFAULT_VAULT_PREFS, show_attachments_in_tree: false, folder_colors: { Folder: "blue" } },
    error: null,
  });
  useWorkspace.setState({
    panes: [{ id: "p", tabs: ["Folder/Note.md"], active: "Folder/Note.md" }],
    focused: "p",
    direction: "row",
    buffers: {},
  });
  useUi.setState({ menu: null, picker: null, sidebarTab: "files" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("file tree rendering and navigation", () => {
  it("covers every file-kind icon and markdown display names", () => {
    const kinds: Array<FileKind | null> = [
      "markdown",
      "canvas",
      "excalidraw",
      "html",
      "image",
      "csv",
      "json",
      "yaml",
      "graphviz",
      "code",
      "pdf",
      null,
    ];
    const { container } = render(
      <>
        {kinds.map((kind, index) => (
          <span key={index}>{kindIcon(kind, 20)}</span>
        ))}
      </>,
    );
    expect(container.querySelectorAll("svg")).toHaveLength(kinds.length);
    expect(displayName({ name: "Note.markdown", kind: "markdown" })).toBe("Note");
    expect(displayName({ name: "data.json", kind: "json" })).toBe("data.json");
  });

  it("filters quiet attachments, renders nesting and handles click selection modes and opening", async () => {
    const select = vi.fn((path: string, _mode: "single" | "toggle" | "range") => {
      useVault.setState({ selected: new Set([path]), anchor: path, cursor: path });
    });
    const toggle = vi.fn();
    const open = vi.fn().mockResolvedValue(undefined);
    useVault.setState({ select, toggle });
    useWorkspace.setState({ open });
    const { rerender } = render(<FileTree />);
    expect(screen.getByTitle("Folder/Sub/Deep.md")).toBeTruthy();
    expect(screen.queryByTitle("Attachments/quiet.png")).toBeNull();
    expect(screen.getByTitle("Folder").getAttribute("aria-label")).toContain("blue folder");
    expect(screen.getByLabelText("Bookmarked")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Folder"));
    expect(toggle).toHaveBeenCalledWith("Folder");
    fireEvent.click(screen.getByTitle("Folder/Note.md"));
    expect(open).toHaveBeenCalledWith("Folder/Note.md", { newTab: false });
    fireEvent.click(screen.getByTitle("Folder/Note.md"), { altKey: true });
    expect(open).toHaveBeenCalledWith("Folder/Note.md", { newTab: true });
    fireEvent.click(screen.getByTitle("Other.md"), { metaKey: true });
    expect(select).toHaveBeenCalledWith("Other.md", "toggle");
    fireEvent.click(screen.getByTitle("Other.md"), { shiftKey: true });
    expect(select).toHaveBeenCalledWith("Other.md", "range", expect.any(Array));
    fireEvent(screen.getByTitle("Other.md"), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(open).toHaveBeenCalledWith("Other.md", { newTab: true });
    fireEvent(screen.getByTitle("Folder"), new MouseEvent("auxclick", { bubbles: true, button: 1 }));

    useVaultPreferences.setState({
      value: { ...useVaultPreferences.getState().value, show_attachments_in_tree: true },
    });
    useVault.setState({ expanded: new Set(["Folder", "Folder/Sub", "Attachments"]) });
    rerender(<FileTree />);
    expect(screen.getByTitle("Attachments/quiet.png")).toBeTruthy();
  });

  it("handles all keyboard commands, ignores inputs and clears selection from the root", () => {
    const clearSelection = vi.fn();
    const setRenaming = vi.fn();
    const setSelection = vi.fn();
    const step = vi.fn().mockReturnValueOnce("Folder/Note.md").mockReturnValueOnce(null);
    useVault.setState({
      selected: new Set(["Folder/Note.md"]),
      clearSelection,
      setRenaming,
      setSelection,
      step,
    });
    render(<FileTree />);
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "Escape" });
    fireEvent.keyDown(tree, { key: "Enter" });
    fireEvent.keyDown(tree, { key: "a", metaKey: true });
    fireEvent.keyDown(tree, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(tree, { key: "ArrowUp" });
    fireEvent.keyDown(tree, { key: "q" });
    expect(clearSelection).toHaveBeenCalled();
    expect(setRenaming).toHaveBeenCalledWith("Folder/Note.md");
    expect(setSelection).toHaveBeenCalledWith(expect.arrayContaining(["Folder", "Other.md"]));
    expect(step).toHaveBeenNthCalledWith(1, 1, true, expect.any(Array));
    expect(step).toHaveBeenNthCalledWith(2, -1, false, expect.any(Array));
    fireEvent.click(tree);
    expect(clearSelection).toHaveBeenCalledTimes(2);

    const input = document.createElement("input");
    tree.append(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(clearSelection).toHaveBeenCalledTimes(2);
  });

  it("shows the empty state and root context menu only for the root target", () => {
    const clearSelection = vi.fn();
    useVault.setState({ entries: [], clearSelection });
    render(<FileTree />);
    expect(screen.getByText(/vault is empty/i)).toBeTruthy();
    const tree = screen.getByRole("tree");
    fireEvent.contextMenu(screen.getByText(/vault is empty/i));
    expect(useUi.getState().menu).toBeNull();
    fireEvent.contextMenu(tree, { clientX: 10, clientY: 20 });
    expect(clearSelection).toHaveBeenCalled();
    const menu = useUi.getState().menu!;
    expect(menu.items.map((item) => item.label)).toEqual(
      expect.arrayContaining(["New note", "New", "New folder", "Collapse all"]),
    );
    const collapse = menu.items.find((item) => item.label === "Collapse all")!;
    collapse.action!();
    expect(useVault.getState().expanded.size).toBe(0);
  });
});

describe("file tree menus and rename editing", () => {
  it("builds the complete file menu and executes copy, bookmark, history and open actions", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const toggleBookmark = vi.fn().mockResolvedValue(undefined);
    const setRenaming = vi.fn();
    const openHistory = vi.fn();
    useWorkspace.setState({ open });
    useVault.setState({ toggleBookmark, setRenaming });
    useUi.setState({ openHistory });
    const absolutePath = vi.spyOn(api, "absolutePath").mockResolvedValue("/vault/Folder/Note.md");
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<FileTree />);
    fireEvent.contextMenu(screen.getByTitle("Folder/Note.md"), { clientX: 5, clientY: 6 });
    await waitFor(() => expect(useUi.getState().menu).not.toBeNull());
    const menu = useUi.getState().menu!.items;
    expect(menu.map((item) => item.label)).toEqual(
      expect.arrayContaining([
        "Open in new tab",
        "Open to the right",
        "File history…",
        "Export",
        "Remove bookmark",
        "Duplicate",
      ]),
    );
    menu.find((item) => item.label === "Open in new tab")!.action!();
    menu.find((item) => item.label === "File history…")!.action!();
    menu.find((item) => item.label === "Remove bookmark")!.action!();
    menu.find((item) => item.label === "Rename")!.action!();
    const copy = menu.find((item) => item.label === "Copy")!;
    for (const item of copy.children!) item.action!();
    await waitFor(() => expect(absolutePath).toHaveBeenCalled());
    expect(writeText).toHaveBeenCalledWith("Folder/Note.md");
    expect(open).toHaveBeenCalledWith("Folder/Note.md", { newTab: true });
    expect(openHistory).toHaveBeenCalledWith("Folder/Note.md");
    expect(toggleBookmark).toHaveBeenCalledWith("Folder/Note.md");
    expect(setRenaming).toHaveBeenCalledWith("Folder/Note.md");
  });

  it("builds folder template menus for inherited, root, blank and failed defaults", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const openSettings = vi.fn();
    useWorkspace.setState({ open });
    useUi.setState({ openSettings });
    const templates = vi
      .spyOn(api, "templates")
      .mockResolvedValueOnce({ templates: [], default: { template: "Templates/Folder.md", rule_folder: "Folder" } })
      .mockResolvedValueOnce({ templates: [], default: { template: "Templates/Root.md", rule_folder: "" } })
      .mockResolvedValueOnce({ templates: [], default: { template: null, rule_folder: null } })
      .mockRejectedValueOnce(new Error("failed"));
    render(<FileTree />);
    const folder = screen.getByTitle("Folder");
    for (let index = 0; index < 4; index++) {
      fireEvent.contextMenu(folder);
      await waitFor(() => expect(templates).toHaveBeenCalledTimes(index + 1));
      const menu = useUi.getState().menu!.items;
      const template = menu.find((item) => item.label.startsWith("Default template"))!;
      if (template.children) {
        template.children.find((item) => item.label === "Edit template")?.action?.();
        template.children.find((item) => item.label === "Change default…")!.action!();
      } else template.action!();
    }
    expect(open).toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalledWith("templates");
  });

  it("builds multi-selection menus for files, folders, bookmarks and opens all files", async () => {
    const select = vi.fn();
    const open = vi.fn().mockResolvedValue(undefined);
    const toggleBookmarks = vi.fn().mockResolvedValue(undefined);
    useWorkspace.setState({ open });
    useVault.setState({
      selected: new Set(["Folder/Note.md", "Other.md"]),
      bookmarks: ["Folder/Note.md", "Other.md"],
      select,
      toggleBookmarks,
    });
    render(<FileTree />);
    fireEvent.contextMenu(screen.getByTitle("Folder/Note.md"));
    let menu = useUi.getState().menu!.items;
    expect(menu.map((item) => item.label)).toEqual(
      expect.arrayContaining(["2 items selected", "Open 2 files in new tabs", "Remove bookmarks", "Copy note links"]),
    );
    menu.find((item) => item.label.startsWith("Open 2"))!.action!();
    menu.find((item) => item.label === "Remove bookmarks")!.action!();
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(toggleBookmarks).toHaveBeenCalled();

    useVault.setState({ selected: new Set(["Folder"]), bookmarks: [] });
    cleanup();
    render(<FileTree />);
    fireEvent.contextMenu(screen.getByTitle("Folder"));
    await waitFor(() => expect(useUi.getState().menu).not.toBeNull());
    menu = useUi.getState().menu!.items;
    expect(menu.some((item) => item.label.startsWith("Open "))).toBe(false);
  });

  it("commits valid renames and handles unchanged, slash, enter and escape cases", async () => {
    const rename = vi.fn().mockResolvedValue("Folder/New.md");
    const setRenaming = vi.fn((path: string | null) => useVault.setState({ renaming: path }));
    const setError = vi.fn();
    useVault.setState({ renaming: "Folder/Note.md", rename, setRenaming, setError });
    const { rerender } = render(<FileTree />);
    let input = screen.getByLabelText("New name") as HTMLInputElement;
    expect(input.value).toBe("Note");
    fireEvent.change(input, { target: { value: "New" } });
    fireEvent.blur(input);
    await waitFor(() => expect(rename).toHaveBeenCalledWith("Folder/Note.md", "Folder/New.md"));

    useVault.setState({ renaming: "Folder/Note.md" });
    rerender(<FileTree />);
    input = screen.getByLabelText("New name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bad/name" } });
    fireEvent.blur(input);
    expect(setError).toHaveBeenCalledWith(expect.stringContaining("can't contain"));

    useVault.setState({ renaming: "Folder/Note.md" });
    rerender(<FileTree />);
    input = screen.getByLabelText("New name") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(setRenaming).toHaveBeenCalledWith(null);
    fireEvent.keyDown(input, { key: "Enter" });
  });
});

describe("tree drag behavior", () => {
  const transfer = (types: string[] = []) => ({
    types,
    dropEffect: "",
    effectAllowed: "",
    data: new Map<string, string>(),
    setData(type: string, value: string) {
      this.data.set(type, value);
      if (!this.types.includes(type)) this.types.push(type);
    },
    getData(type: string) {
      return this.data.get(type) ?? "";
    },
    items: [],
    files: [],
  });

  it("starts tree drags and moves allowed selections while rejecting self moves", async () => {
    const select = vi.fn((path: string) => useVault.setState({ selected: new Set([path]) }));
    const rename = vi.fn().mockImplementation(async (_from: string, to: string) => to);
    useVault.setState({ selected: new Set(), select, rename });
    render(<FileTree />);
    const note = screen.getByTitle("Folder/Note.md");
    const dt = transfer();
    fireEvent.dragStart(note, { dataTransfer: dt });
    expect(dt.data.get("application/x-mosaic-path")).toContain("Folder/Note.md");
    expect(dt.data.get("text/plain")).toContain("[[Note]]");
    const other = screen.getByTitle("Folder/Sub");
    fireEvent.dragOver(other, { dataTransfer: dt });
    expect(dt.dropEffect).toBe("move");
    fireEvent.drop(other, { dataTransfer: dt });
    await waitFor(() => expect(rename).toHaveBeenCalledWith("Folder/Note.md", "Folder/Sub/Note.md"));

    const folderDt = transfer();
    fireEvent.dragStart(screen.getByTitle("Folder"), { dataTransfer: folderDt });
    fireEvent.dragOver(screen.getByTitle("Folder/Sub"), { dataTransfer: folderDt });
    expect(folderDt.dropEffect).toBe("none");
    fireEvent.dragLeave(screen.getByTitle("Folder/Sub"), { dataTransfer: folderDt });
    fireEvent.dragEnd(screen.getByTitle("Folder"), { dataTransfer: folderDt });
  });

  it("ignores unrelated drags and runs hover-open and auto-scroll cleanup", () => {
    vi.useFakeTimers();
    const toggle = vi.fn();
    useVault.setState({ toggle, selected: new Set(["Other.md"]), expanded: new Set(["Folder"]) });
    const { unmount } = render(<FileTree />);
    const tree = screen.getByRole("tree");
    Object.defineProperties(tree, {
      scrollTop: { configurable: true, writable: true, value: 10 },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect(0, 0, 200, 200) },
    });
    const unrelated = transfer(["text/plain"]);
    fireEvent.dragOver(screen.getByTitle("Folder/Sub"), { dataTransfer: unrelated });
    const internal = transfer(["application/x-mosaic-path"]);
    fireEvent.dragStart(screen.getByTitle("Other.md"), { dataTransfer: internal });
    fireEvent.dragOver(screen.getByTitle("Folder/Sub"), { dataTransfer: internal, clientY: 1 });
    vi.advanceTimersByTime(600);
    expect(toggle).toHaveBeenCalledWith("Folder/Sub", true);
    fireEvent.dragOver(tree, { dataTransfer: internal, clientY: 100 });
    fireEvent.dragLeave(tree, { dataTransfer: internal, relatedTarget: document.body });
    unmount();
    vi.useRealTimers();
  });
});
