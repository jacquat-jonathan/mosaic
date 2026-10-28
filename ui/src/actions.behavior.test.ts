// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NEW_KINDS,
  canMoveInto,
  canvasFromFiles,
  canvasOfFiles,
  copyText,
  createVault,
  deletePath,
  deletePaths,
  droppedItems,
  duplicatePath,
  embedsFor,
  importDropped,
  isFinderDrag,
  moveAllInto,
  moveInto,
  newDiagram,
  newFileOfKind,
  newNote,
  newNoteDir,
  newOfKind,
  openCalendar,
  openDailyNote,
  openToTheRight,
  openVaultFolder,
  pickFolderAndMove,
  renamePath,
  revealInTree,
  setExpandedDeep,
  wikilinkFor,
} from "./actions";
import { api } from "./ipc/api";
import type { Entry } from "./ipc/types";
import { DEFAULT_PREFS, useSettings } from "./state/settings";
import { useUi } from "./state/ui";
import { useVault } from "./state/vault";
import { DEFAULT_VAULT_PREFS, useVaultPreferences } from "./state/vaultPreferences";
import { useWorkspace } from "./state/workspace";

const fileEntry = (path: string, is_dir = false): Entry => ({
  path,
  name: path.split("/").pop()!,
  is_dir,
  kind: is_dir ? null : "markdown",
  size: 0,
  mtime: 0,
});

const buffer = (path: string, dirty = false) => ({
  path,
  kind: "markdown" as const,
  content: "",
  baseHash: "hash",
  dirty,
  conflict: null,
  deleted: false,
  error: null,
  version: 1,
});

beforeEach(() => {
  useSettings.setState(DEFAULT_PREFS);
  useVaultPreferences.setState({ root: "/vault", value: DEFAULT_VAULT_PREFS, error: null });
  useVault.setState({
    vault: { root: "/vault", name: "Vault" },
    entries: [],
    expanded: new Set(),
    selected: new Set(),
    anchor: null,
    cursor: null,
    error: null,
    renaming: null,
  });
  useWorkspace.setState({
    panes: [{ id: "p", tabs: [], active: null }],
    direction: "row",
    focused: "p",
    buffers: {},
  });
  useUi.setState({ newNote: null, picker: null, menu: null, sidebarTab: "files" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("file actions", () => {
  it("chooses new-note destinations and opens the new-note dialog only for an open vault", async () => {
    useVaultPreferences.setState({ value: { ...DEFAULT_VAULT_PREFS, new_note_location: "root" } });
    expect(newNoteDir()).toBe("");
    useVaultPreferences.setState({
      value: { ...DEFAULT_VAULT_PREFS, new_note_location: "folder", new_note_folder: "Inbox" },
    });
    expect(newNoteDir()).toBe("Inbox");
    useVaultPreferences.setState({ value: { ...DEFAULT_VAULT_PREFS, new_note_location: "current" } });
    useWorkspace.setState({ panes: [{ id: "p", tabs: ["A/Note.md"], active: "A/Note.md" }] });
    expect(newNoteDir()).toBe("A");
    useWorkspace.setState({ panes: [{ id: "p", tabs: [], active: null }] });
    expect(newNoteDir()).toBe("");

    await newNote("Inbox", "Idea", false);
    expect(useUi.getState().newNote).toEqual({ dir: "Inbox", root: "/vault", name: "Idea", newTab: false });
    useVault.setState({ vault: null });
    useUi.setState({ newNote: null });
    await newNote("Inbox");
    expect(useUi.getState().newNote).toBeNull();
  });

  it("creates, opens and renames files and rejects invalid move destinations", async () => {
    const newFile = vi.fn().mockResolvedValueOnce("Dir/New.md").mockResolvedValueOnce(null);
    const open = vi.fn().mockResolvedValue(undefined);
    const renamed = vi.fn();
    const rename = vi.fn().mockResolvedValueOnce("Dir/Renamed.md").mockResolvedValueOnce(null);
    useVault.setState({ newFile, rename });
    useWorkspace.setState({ open, renamed });
    expect(await newFileOfKind("Dir", "New", "md", "body")).toBe("Dir/New.md");
    expect(open).toHaveBeenCalledWith("Dir/New.md", { newTab: true });
    expect(await newFileOfKind("Dir", "No", "md", "")).toBeNull();
    expect(await renamePath("Dir/Old.md", "Dir/Renamed.md")).toBe("Dir/Renamed.md");
    expect(renamed).toHaveBeenCalledWith("Dir/Old.md", "Dir/Renamed.md");
    expect(await renamePath("bad", "no")).toBeNull();

    expect(canMoveInto("A/file.md", "A")).toBe(false);
    expect(canMoveInto("A", "A")).toBe(false);
    expect(canMoveInto("A", "A/B")).toBe(false);
    expect(canMoveInto("A/file.md", "B")).toBe(true);
    rename.mockResolvedValue("B/file.md");
    await moveInto("A/file.md", "B");
    await moveInto("A/file.md", "A");
    expect(rename).toHaveBeenCalledTimes(3);

    rename.mockClear().mockImplementation(async (_from: string, to: string) => to);
    await moveAllInto(["A", "A/inside.md", "B.md"], "Target");
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it("builds and executes a move picker for one and several selected items", async () => {
    const rename = vi.fn().mockImplementation(async (_from: string, to: string) => to);
    useVault.setState({
      entries: [fileEntry("Folder", true), fileEntry("Folder/Sub", true), fileEntry("Other", true)],
      rename,
    });
    pickFolderAndMove(["Folder/file.md"]);
    let picker = useUi.getState().picker!;
    expect(picker.placeholder).toContain("file");
    expect(picker.items.some((item) => item.label === "Vault root")).toBe(true);
    picker.onPick(picker.items.find((item) => item.id === "Other")!);
    await vi.waitFor(() => expect(rename).toHaveBeenCalledWith("Folder/file.md", "Other/file.md"));

    pickFolderAndMove(["A.md", "B.md"]);
    picker = useUi.getState().picker!;
    expect(picker.placeholder).toContain("2 items");
  });

  it("deletes one or many paths with confirmation, dirty-buffer cleanup and early failure", async () => {
    const remove = vi.fn().mockResolvedValue(true);
    const deleted = vi.fn();
    const clearSelection = vi.fn();
    const ask = vi.fn().mockResolvedValue(false);
    useVault.setState({ entries: [fileEntry("One.md")], remove, clearSelection });
    useWorkspace.setState({ deleted, buffers: { "One.md": buffer("One.md", true) } });
    useUi.setState({ ask });
    await deletePaths([]);
    await deletePaths(["One.md"]);
    expect(remove).not.toHaveBeenCalled();
    ask.mockResolvedValue(true);
    await deletePaths(["One.md"]);
    expect(remove).toHaveBeenCalledWith("One.md");
    expect(useWorkspace.getState().buffers["One.md"].dirty).toBe(false);

    useSettings.setState({ confirmTrash: false });
    remove.mockClear().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    useWorkspace.setState({
      buffers: { "A/dirty.md": buffer("A/dirty.md", true), "B.md": buffer("B.md") },
    });
    ask.mockResolvedValue(true);
    await deletePaths(["A", "A/inside.md", "B.md", "C.md"]);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(clearSelection).toHaveBeenCalled();
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("unsaved") }));

    useWorkspace.setState({ buffers: {} });
    ask.mockClear().mockResolvedValue(false);
    useSettings.setState({ confirmTrash: true });
    await deletePaths(["B.md", "C.md"]);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("restore") }));
  });

  it("duplicates every filename shape and surfaces copy errors", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const setSelection = vi.fn();
    const setRenaming = vi.fn();
    const setError = vi.fn();
    useVault.setState({
      entries: [fileEntry("Dir/A.md"), fileEntry("Dir/A 1.md"), fileEntry("Chart.vl.json"), fileEntry("LICENSE")],
      refresh,
      setSelection,
      setRenaming,
      setError,
    });
    const copy = vi.spyOn(api, "copy").mockResolvedValue({ path: "copied", hash: "h" });
    await duplicatePath("Dir/A.md");
    expect(copy).toHaveBeenCalledWith("Dir/A.md", "Dir/A 2.md");
    await duplicatePath("Chart.vl.json");
    expect(copy).toHaveBeenCalledWith("Chart.vl.json", "Chart 1.vl.json");
    await duplicatePath("LICENSE");
    expect(copy).toHaveBeenCalledWith("LICENSE", "LICENSE 1");
    copy.mockRejectedValueOnce(new Error("copy failed"));
    await duplicatePath("Broken.md");
    expect(setError).toHaveBeenCalledWith("copy failed");
  });

  it("produces wiki, markdown and embed links for clashes and relative paths", () => {
    useVault.setState({
      entries: [fileEntry("A/Same.md"), fileEntry("B/Same.md"), fileEntry("Images/photo.png"), fileEntry("Doc.pdf")],
    });
    expect(wikilinkFor("A/Same.md", "A/From.md")).toBe("[[A/Same]]");
    expect(wikilinkFor("Images/photo.png")).toBe("[[photo.png]]");
    useVault.setState({ entries: [fileEntry("Only.md")] });
    expect(wikilinkFor("Only.md")).toBe("[[Only]]");
    useVaultPreferences.setState({ value: { ...DEFAULT_VAULT_PREFS, link_style: "markdown" } });
    expect(wikilinkFor("Folder/(Odd) [name].md", "Folder/Sub/From.md")).toBe(
      "[(Odd) \\[name\\]](../%28Odd%29%20%5Bname%5D.md)",
    );
    useVaultPreferences.setState({ value: DEFAULT_VAULT_PREFS });
    expect(embedsFor(["Images/photo.png", "Doc.pdf", "Only.md"], "From.md")).toBe(
      "![[photo.png]]\n![[Doc.pdf]]\n[[Only]]",
    );
  });
});

describe("workspace and system actions", () => {
  it("copies text, reports clipboard failures and reveals a file in the tree", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const setError = vi.fn();
    const revealParents = vi.fn();
    const setSelection = vi.fn();
    const setSidebarTab = vi.fn();
    useVault.setState({ setError, revealParents, setSelection });
    useUi.setState({ setSidebarTab });
    await copyText("hello");
    expect(writeText).toHaveBeenCalledWith("hello");
    writeText.mockRejectedValueOnce(new Error("denied"));
    await copyText("no");
    expect(setError).toHaveBeenCalledWith(expect.stringContaining("denied"));

    const scrollIntoView = vi.fn();
    vi.spyOn(document, "querySelector").mockReturnValue({ scrollIntoView } as unknown as Element);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    revealInTree("A/B.md");
    expect(revealParents).toHaveBeenCalledWith("A/B.md");
    expect(setSelection).toHaveBeenCalledWith(["A/B.md"]);
    expect(setSidebarTab).toHaveBeenCalledWith("files");
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("expands descendants, opens a split and opens the calendar", async () => {
    useVault.setState({
      entries: [fileEntry("A", true), fileEntry("A/B", true), fileEntry("Other", true)],
      expanded: new Set(["Other", "A"]),
    });
    setExpandedDeep("A", true);
    expect(useVault.getState().expanded).toEqual(new Set(["Other", "A", "A/B"]));
    setExpandedDeep("A", false);
    expect(useVault.getState().expanded).toEqual(new Set(["Other"]));

    const split = vi.fn();
    const open = vi.fn().mockResolvedValue(undefined);
    useWorkspace.setState({ split, open });
    await openToTheRight("A.md");
    expect(split).toHaveBeenCalledWith("row");
    expect(open).toHaveBeenCalledWith("A.md");
    openCalendar();
    expect(open).toHaveBeenCalledWith("mosaic:calendar", { newTab: true });
  });

  it("opens and creates vaults through the native folder picker", async () => {
    const openVault = vi.fn().mockResolvedValue(undefined);
    useVault.setState({ openVault });
    await openVaultFolder();
    expect(openVault).toHaveBeenCalledWith("/mock/vault");

    const askText = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(" ").mockResolvedValueOnce("New Vault");
    useUi.setState({ askText });
    const create = vi.spyOn(api, "createVault").mockResolvedValue({ root: "/mock/vault/New Vault", name: "New Vault" });
    await createVault();
    await createVault();
    await createVault();
    expect(create).toHaveBeenCalledWith("/mock/vault", "New Vault");
    expect(openVault).toHaveBeenCalledWith("/mock/vault/New Vault");
  });

  it("deletes files and folders with all confirmation descriptions", async () => {
    const remove = vi.fn().mockResolvedValue(true);
    const deleted = vi.fn();
    const ask = vi.fn().mockResolvedValue(true);
    useVault.setState({ remove });
    useWorkspace.setState({ deleted, buffers: {} });
    useUi.setState({ ask });
    await deletePath("Folder", true);
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.stringContaining("folder") }));
    await deletePath("Note.md", false);
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.stringContaining("file") }));
    ask.mockResolvedValueOnce(false);
    await deletePath("Cancel.md", false);
    remove.mockResolvedValueOnce(false);
    await deletePath("Failure.md", false);
    expect(deleted).toHaveBeenCalledTimes(2);
  });
});

describe("daily notes, diagrams and imports", () => {
  it("opens existing daily notes and creates missing notes with templates and carry-over errors", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const setError = vi.fn();
    useWorkspace.setState({ open });
    useVault.setState({ setError, entries: [fileEntry("Daily/2026-10-28.md")] });
    vi.spyOn(api, "days").mockResolvedValue({
      days: [{ date: "2026-10-28", note: "Daily/2026-10-28.md", tasks: [] }],
      overdue: [],
    });
    const create = vi.spyOn(api, "create").mockResolvedValue({ path: "x", hash: "h" });
    await openDailyNote(new Date("2026-10-28T12:00:00Z"), { newTab: true });
    expect(open).toHaveBeenCalledWith("Daily/2026-10-28.md", { newTab: true });
    expect(create).not.toHaveBeenCalled();

    vi.spyOn(api, "days").mockResolvedValue({ days: [{ date: "2030-01-02", note: null, tasks: [] }], overdue: [] });
    vi.spyOn(api, "read").mockResolvedValue({
      path: "Templates/Daily.md",
      kind: "markdown",
      size: 1,
      mtime: 1,
      hash: "h",
      content: "# {{title}} {{date}}",
    });
    useVaultPreferences.setState({
      value: {
        ...DEFAULT_VAULT_PREFS,
        daily_folder: "Daily",
        daily_template: "Templates/Daily",
        daily_format: "YYYY-MM-DD",
      },
    });
    useVault.setState({ entries: [fileEntry("Templates/Daily.md")] });
    await openDailyNote(new Date("2030-01-02T12:00:00Z"));
    expect(create).toHaveBeenCalledWith("Daily/2030-01-02.md", expect.stringContaining("2030-01-02"));

    useVault.setState({ entries: [] });
    create.mockRejectedValueOnce({ code: "already_exists" });
    await openDailyNote(new Date("2030-01-03T12:00:00Z"));
    expect(setError).toHaveBeenCalledWith(expect.stringContaining("wasn't found"));
    create.mockRejectedValueOnce(new Error("create failed"));
    await expect(openDailyNote(new Date("2030-01-04T12:00:00Z"))).rejects.toThrow("create failed");
  });

  it("creates canvas JSON, selection canvases and every new-kind branch", async () => {
    let id = 0;
    const canvas = JSON.parse(canvasOfFiles(["A.md", "B.md", "C.md", "D.md"], () => String(++id)));
    expect(canvas.nodes[3]).toMatchObject({ x: 0, y: 280, file: "D.md" });

    const newFile = vi.fn().mockResolvedValue("Canvas.canvas");
    const setRenaming = vi.fn();
    useVault.setState({ newFile, setRenaming });
    useWorkspace.setState({ open: vi.fn().mockResolvedValue(undefined) });
    await canvasFromFiles(["Folder/A.md", "Folder/B.md"]);
    expect(setRenaming).toHaveBeenCalledWith("Canvas.canvas");

    await newOfKind("Folder", NEW_KINDS[0]);
    expect(useUi.getState().newNote).not.toBeNull();
    await newOfKind("Folder", NEW_KINDS[1]);
    let picker = useUi.getState().picker!;
    expect(picker.items.length).toBeGreaterThan(1);
    picker.onPick(picker.items[0]);
    await vi.waitFor(() => expect(newFile).toHaveBeenCalled());
    await newOfKind("Folder", NEW_KINDS[3]);
    expect(setRenaming).toHaveBeenCalled();

    await newDiagram("Elsewhere");
    picker = useUi.getState().picker!;
    picker.onPick(picker.items.at(-1)!);
    await vi.waitFor(() =>
      expect(newFile).toHaveBeenCalledWith("Elsewhere", expect.any(String), "canvas", expect.any(String)),
    );
  });

  it("identifies Finder drops, falls back to files and imports files, folders and errors", async () => {
    expect(isFinderDrag({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(isFinderDrag({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
    const file = new File(["data"], "note.txt");
    const entry = { name: "entry", isFile: true } as unknown as FileSystemEntry;
    expect(
      droppedItems({
        items: [
          { kind: "string", webkitGetAsEntry: () => null, getAsFile: () => null },
          { kind: "file", webkitGetAsEntry: () => entry, getAsFile: () => file },
        ],
        files: [file],
      } as unknown as DataTransfer),
    ).toEqual([entry]);
    expect(
      droppedItems({
        items: [{ kind: "file", webkitGetAsEntry: () => null, getAsFile: () => null }],
        files: [file],
      } as unknown as DataTransfer),
    ).toEqual([file]);

    Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("data").buffer });
    const hidden = new File(["x"], ".DS_Store");
    Object.defineProperty(hidden, "arrayBuffer", { value: async () => new ArrayBuffer(0) });
    const nested = new File(["nested"], "nested.txt");
    Object.defineProperty(nested, "arrayBuffer", { value: async () => new TextEncoder().encode("nested").buffer });
    let read = false;
    const folder = {
      name: "Folder",
      isFile: false,
      isDirectory: true,
      createReader: () => ({
        readEntries: (ok: (entries: FileSystemEntry[]) => void) => {
          ok(read ? [] : ([nested] as unknown as FileSystemEntry[]));
          read = true;
        },
      }),
    } as unknown as FileSystemDirectoryEntry;
    vi.spyOn(api, "importFile").mockImplementation(async (path) => ({ path, hash: "h" }));
    vi.spyOn(api, "mkdir").mockResolvedValue(null);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const toggle = vi.fn();
    const setSelection = vi.fn();
    const setError = vi.fn();
    useVault.setState({ entries: [fileEntry("Folder", true)], refresh, toggle, setSelection, setError });
    expect(await importDropped([hidden, file, folder], "Imports")).toEqual(["Imports/note.txt", "Imports/Folder"]);
    expect(toggle).toHaveBeenCalledWith("Imports", true);
    expect(setSelection).toHaveBeenCalled();

    vi.spyOn(api, "importFile").mockRejectedValueOnce(new Error("import failed"));
    expect(await importDropped([file], "")).toEqual([]);
    expect(setError).toHaveBeenCalledWith("import failed");
  });
});
