import { beforeEach, expect, test, vi } from "vitest";
import { useWorkspace, AUTOSAVE_MS } from "./workspace";
import { api } from "../ipc/api";
import { uniquePath } from "./vault";

const ws = () => useWorkspace.getState();

beforeEach(() => {
  useWorkspace.setState({ panes: [{ id: "p", tabs: [], active: null }], focused: "p", buffers: {}, direction: "row" });
});

test("opening without newTab replaces the active clean tab", async () => {
  await ws().open("Welcome.md");
  await ws().open("Ideas.md");
  expect(ws().panes[0].tabs).toEqual(["Ideas.md"]);
  await ws().open("Welcome.md", { newTab: true });
  expect(ws().panes[0].tabs).toEqual(["Ideas.md", "Welcome.md"]);
  expect(Object.keys(ws().buffers).sort()).toEqual(["Ideas.md", "Welcome.md"]);
});

test("a dirty tab is kept when opening another file", async () => {
  vi.useFakeTimers();
  await ws().open("Welcome.md");
  ws().edit("Welcome.md", "changed");
  await ws().open("Ideas.md");
  expect(ws().panes[0].tabs).toEqual(["Welcome.md", "Ideas.md"]);
  vi.useRealTimers();
});

test("rename remaps tabs and buffers, including folders", async () => {
  await ws().open("Projects/Mosaic/Plan.md");
  ws().renamed("Projects", "Work");
  expect(ws().panes[0].tabs).toEqual(["Work/Mosaic/Plan.md"]);
  expect(ws().buffers["Work/Mosaic/Plan.md"].path).toBe("Work/Mosaic/Plan.md");
});

test("autosave writes with the base hash and a stale hash raises a conflict", async () => {
  vi.useFakeTimers();
  await ws().open("Ideas.md");
  ws().edit("Ideas.md", "# Ideas v2\n");
  await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 10);
  expect(ws().buffers["Ideas.md"].dirty).toBe(false);
  expect((await api.read("Ideas.md")).content).toBe("# Ideas v2\n");

  await api.write("Ideas.md", "external change");
  ws().edit("Ideas.md", "mine");
  await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 10);
  expect(ws().buffers["Ideas.md"].conflict).not.toBeNull();
  expect((await api.read("Ideas.md")).content).toBe("external change");
  vi.useRealTimers();
});

test("split and close panes", async () => {
  await ws().open("Welcome.md");
  ws().split("row");
  expect(ws().panes).toHaveLength(2);
  expect(ws().panes[1].tabs).toEqual(["Welcome.md"]);
  ws().closeTab(ws().panes[1].id, "Welcome.md");
  expect(ws().panes).toHaveLength(1);
});

test("uniquePath picks the first free name", () => {
  const existing = new Set(["untitled.md", "untitled 1.md"]);
  expect(uniquePath(existing, "", "Untitled", "md")).toBe("Untitled 2.md");
  expect(uniquePath(new Set(), "a/b", "New folder", "")).toBe("a/b/New folder");
});
