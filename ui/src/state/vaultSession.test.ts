// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, onHistoryChanged, onPlannerChanged, onVaultChanged } from "../ipc/api";
import { useVault } from "./vault";
import { isCurrentSession, vaultOperation } from "./vaultSession";
import { useWorkspace } from "./workspace";
import { useVaultPreferences, DEFAULT_VAULT_PREFS } from "./vaultPreferences";
import { usePlanning } from "./planning";
import { useUi } from "./ui";
import { useChat } from "./chat";
import { useReview } from "./review";
const activate = (root: string, generation: string) => {
  const vault = { root, name: root, session: { root, generation, vault_id: root } };
  useVault.setState({ vault });
  return vault;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  localStorage.clear();
  activate("/a", "1");
  useWorkspace.setState({ buffers: {}, panes: [] });
  useVault.setState({ entries: [], bookmarks: [], aliases: [], unfinishedRenames: [], error: null });
  useVaultPreferences.setState({ value: { ...DEFAULT_VAULT_PREFS, legacy_migrated: true } });
  vi.spyOn(api, "list").mockResolvedValue([]);
  vi.spyOn(api, "aliases").mockResolvedValue([]);
  vi.spyOn(api, "unfinishedRenames").mockResolvedValue([]);
  vi.spyOn(api, "bookmarks").mockResolvedValue([]);
  vi.spyOn(api, "vaultPreferences").mockResolvedValue(useVaultPreferences.getState().value);
});
afterEach(() => vi.restoreAllMocks());
test("returning to the same root invalidates old operations and events", () => {
  const old = useVault.getState().vault!;
  const current = vaultOperation();
  activate("/b", "2");
  activate("/a", "3");
  expect(current()).toBe(false);
  expect(isCurrentSession(old.session!)).toBe(false);
  expect(isCurrentSession(useVault.getState().vault!.session!)).toBe(true);
  expect(isCurrentSession()).toBe(false);
});
test("file, history and planner listeners reject earlier activations", async () => {
  const old = useVault.getState().vault!.session;
  const callbacks = [vi.fn(), vi.fn(), vi.fn()];
  const offs = await Promise.all([
    onVaultChanged(callbacks[0]),
    onHistoryChanged(callbacks[1]),
    onPlannerChanged(callbacks[2]),
  ]);
  const active = activate("/a", "2").session;
  for (const session of [old, active]) {
    window.dispatchEvent(
      new CustomEvent("mock-vault-changed", { detail: { session, paths: ["x.md"], root_missing: false } }),
    );
    window.dispatchEvent(new CustomEvent("mock-history-changed", { detail: session }));
    window.dispatchEvent(
      new CustomEvent("mock-planner-changed", { detail: { session, root: "/a", revision: 1, affected_ids: [] } }),
    );
  }
  for (const cb of callbacks) expect(cb).toHaveBeenCalledTimes(1);
  offs.forEach((off) => off());
});
test("late refresh cannot overwrite a reopened vault tree", async () => {
  const request = deferred<Awaited<ReturnType<typeof api.list>>>();
  vi.mocked(api.list).mockReturnValueOnce(request.promise);
  const pending = useVault.getState().refresh();
  activate("/b", "2");
  activate("/a", "3");
  const entries = [{ path: "new.md", name: "new.md", is_dir: false, kind: "markdown", size: 0, mtime: 0 }] as Awaited<
    ReturnType<typeof api.list>
  >;
  useVault.setState({ entries });
  request.resolve([]);
  await pending;
  expect(useVault.getState().entries).toBe(entries);
});
test("late reconnect cannot replace the same root's newer activation", async () => {
  const request = deferred<Awaited<ReturnType<typeof api.openVault>>>();
  vi.spyOn(api, "openVault").mockReturnValueOnce(request.promise);
  const pending = useVault.getState().openVault("/a", { preserveWorkspace: true });
  const newer = activate("/a", "3");
  request.resolve({ root: "/a", name: "old reconnect", session: { root: "/a", generation: "2", vault_id: "/a" } });
  await pending;
  expect(useVault.getState().vault).toBe(newer);
});
test("late proposal reads cannot populate the next activation", async () => {
  const request = deferred<Awaited<ReturnType<typeof api.proposals>>>();
  vi.spyOn(api, "proposals").mockReturnValueOnce(request.promise);
  const pending = useReview.getState().refresh();
  activate("/b", "2");
  useReview.setState({ pending: [], initialized: false });
  request.resolve([{ id: 42, updated: 1, stale: false }] as Awaited<ReturnType<typeof api.proposals>>);
  await pending;
  expect(useReview.getState().pending).toEqual([]);
  expect(useReview.getState().initialized).toBe(false);
});

test("a failed queued open leaves the native and visible vault on the last successful activation", async () => {
  const request = deferred<Awaited<ReturnType<typeof api.openVault>>>();
  const firstStarted = deferred<void>();
  const first = { root: "/b", name: "B", session: { root: "/b", generation: "2", vault_id: "b" } };
  let nativeRoot = "/a";
  const open = vi
    .spyOn(api, "openVault")
    .mockImplementationOnce(async () => {
      firstStarted.resolve();
      const vault = await request.promise;
      nativeRoot = vault.root;
      return vault;
    })
    .mockRejectedValueOnce(new Error("cannot open C"));
  const a = useVault.getState().openVault("/b");
  await firstStarted.promise;
  const b = useVault.getState().openVault("/c");
  expect(open).toHaveBeenCalledTimes(1);
  request.resolve(first);
  await Promise.all([a, b]);
  expect(nativeRoot).toBe("/b");
  expect(useVault.getState().vault).toBe(first);
  expect(useVault.getState().error).toBe("cannot open C");
});

test("a failed reconnect preserves dirty buffers and the previous activation", async () => {
  const vault = useVault.getState().vault;
  const buffers = {
    "draft.md": {
      path: "draft.md",
      kind: "markdown",
      content: "unsaved",
      baseHash: "h",
      dirty: true,
      conflict: null,
      deleted: false,
      error: null,
      version: 1,
    },
  } as ReturnType<typeof useWorkspace.getState>["buffers"];
  useWorkspace.setState({ buffers });
  vi.spyOn(api, "openVault").mockRejectedValueOnce(new Error("offline"));
  await useVault.getState().openVault("/a", { preserveWorkspace: true });
  expect(useVault.getState().vault).toBe(vault);
  expect(useWorkspace.getState().buffers).toBe(buffers);
});

test("a delayed chat failure cannot alter a restored same-root conversation", async () => {
  useChat.getState().restore("/a");
  const id = useChat.getState().create();
  let reject!: (error: Error) => void;
  vi.spyOn(api, "chatSend").mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const pending = useChat.getState().send(id, "old request", [], null, null, null, null);
  activate("/a", "2");
  useChat.getState().restore("/a");
  const restored = useChat.getState().chats[id];
  reject(new Error("old activation failure"));
  await pending;
  expect(useChat.getState().chats[id]).toBe(restored);
});

test("an old planning dialog cannot create a view after same-root reactivation", async () => {
  usePlanning.getState().restore("/a");
  const answer = deferred<string | null>();
  const ask = vi.spyOn(useUi.getState(), "askText").mockReturnValueOnce(answer.promise);
  const pending = usePlanning.getState().create();
  activate("/a", "2");
  usePlanning.getState().restore("/a");
  answer.resolve("Old view");
  await pending;
  expect(ask).toHaveBeenCalledTimes(1);
  expect(usePlanning.getState().views).toEqual([]);
});
