// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import { useVault } from "./vault";
import { useWorkspace, type Buffer } from "./workspace";
import { useVaultPreferences } from "./vaultPreferences";
const draft: Buffer = {
  path: "draft.md",
  kind: "markdown",
  content: "Unsaved words",
  baseHash: "base",
  dirty: true,
  conflict: null,
  deleted: false,
  error: null,
  version: 1,
};
beforeEach(() => {
  useVault.setState({ vault: { root: "/vault", name: "Vault" }, offline: true });
  useWorkspace.setState({
    panes: [{ id: "p", tabs: ["draft.md"], active: "draft.md" }],
    focused: "p",
    buffers: { "draft.md": { ...draft } },
  });
  vi.spyOn(api, "vaultPreferences").mockResolvedValue(useVaultPreferences.getState().value);
  vi.spyOn(api, "list").mockResolvedValue([]);
  vi.spyOn(api, "aliases").mockResolvedValue([]);
  vi.spyOn(api, "unfinishedRenames").mockResolvedValue([]);
  vi.spyOn(api, "bookmarks").mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());
test("reconnection preserves unsaved buffers and panes, then reconciles their disk state", async () => {
  vi.spyOn(api, "openVault").mockResolvedValue({ root: "/vault", name: "Vault" });
  const restore = vi.spyOn(useWorkspace.getState(), "restoreLayout");
  const reconcile = vi.spyOn(useWorkspace.getState(), "externalChange").mockResolvedValue();
  const panes = useWorkspace.getState().panes;
  await useVault.getState().openVault("/vault", { preserveWorkspace: true });
  expect(useVault.getState().offline).toBe(false);
  expect(useWorkspace.getState().panes).toBe(panes);
  expect(useWorkspace.getState().buffers["draft.md"].content).toBe("Unsaved words");
  expect(useWorkspace.getState().buffers["draft.md"].dirty).toBe(true);
  expect(restore).not.toHaveBeenCalled();
  expect(reconcile).toHaveBeenCalledWith("draft.md");
});
test("a late reconnect cannot replace a newly selected vault", async () => {
  let finish!: () => void;
  vi.spyOn(api, "openVault").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ root: "/vault", name: "Old" });
      }),
  );
  const pending = useVault.getState().openVault("/vault", { preserveWorkspace: true });
  useVault.setState({ vault: { root: "/other", name: "Other" }, offline: false });
  finish();
  await pending;
  expect(useVault.getState().vault?.root).toBe("/other");
  expect(api.list).not.toHaveBeenCalled();
});
