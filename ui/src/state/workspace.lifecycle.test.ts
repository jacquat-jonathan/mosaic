// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useWorkspace, type Buffer } from "./workspace";
import { useVault } from "./vault";
import { api } from "../ipc/api";
const ws = () => useWorkspace.getState();
const buffer: Buffer = {
  path: "Same.md",
  kind: "markdown",
  content: "current draft",
  baseHash: "current",
  dirty: true,
  conflict: null,
  deleted: false,
  error: null,
  version: 1,
};
function selectRoot(root: string) {
  useVault.setState({ vault: { ...useVault.getState().vault!, root } });
}
beforeEach(async () => {
  localStorage.clear();
  selectRoot("/old");
  await ws().restoreLayout("/old");
});
afterEach(() => {
  vi.restoreAllMocks();
});
test("a read from a previous workspace cannot replace a new same-path draft", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof api.read>>) => void;
  vi.spyOn(api, "read").mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = ws().ensure("Same.md");
  await ws().restoreLayout("/old");
  useWorkspace.setState({ buffers: { "Same.md": buffer } });
  resolve({ ...buffer, hash: "old", content: "stale disk", size: 10, mtime: 1 } as Awaited<
    ReturnType<typeof api.read>
  >);
  await pending;
  expect(ws().buffers["Same.md"]).toBe(buffer);
});
test("a late save acknowledgement cannot clean a new vault's draft", async () => {
  useWorkspace.setState({ buffers: { "Same.md": { ...buffer, content: "old draft" } } });
  let resolve!: (value: Awaited<ReturnType<typeof api.write>>) => void;
  const write = vi.spyOn(api, "write").mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = ws().save("Same.md");
  expect(write).toHaveBeenCalledWith("Same.md", "old draft", "current", "/old");
  selectRoot("/new");
  await ws().restoreLayout("/new");
  useWorkspace.setState({ buffers: { "Same.md": buffer } });
  resolve({ path: "Same.md", hash: "old saved hash" } as Awaited<ReturnType<typeof api.write>>);
  await pending;
  expect(ws().buffers["Same.md"]).toBe(buffer);
});
test("external-change reads cannot create a conflict in another vault", async () => {
  useWorkspace.setState({ buffers: { "Same.md": buffer } });
  let resolve!: (value: Awaited<ReturnType<typeof api.read>>) => void;
  vi.spyOn(api, "read").mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = ws().externalChange("Same.md");
  selectRoot("/new");
  await ws().restoreLayout("/new");
  useWorkspace.setState({ buffers: { "Same.md": buffer } });
  resolve({ ...buffer, hash: "stale", content: "old vault disk", size: 10, mtime: 1 } as Awaited<
    ReturnType<typeof api.read>
  >);
  await pending;
  expect(ws().buffers["Same.md"]).toBe(buffer);
});
