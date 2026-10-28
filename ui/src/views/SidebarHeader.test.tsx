// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../ipc/api";
import { useVault } from "../state/vault";
import { useUi } from "../state/ui";
import { SidebarHeader } from "./SidebarHeader";
const vault = { root: "/vault", name: "Vault" };
const recent = [
  { ...vault, exists: true },
  { root: "/other", name: "Other", exists: false },
];
beforeEach(() => {
  useVault.setState({ vault, error: null });
  useUi.setState({ menu: null, prompt: null, picker: null, confirm: null });
  vi.spyOn(ipc.api, "recentVaults").mockResolvedValue(recent);
  vi.spyOn(ipc, "pickFolder").mockResolvedValue("/parent");
  vi.spyOn(useUi.getState(), "askText").mockResolvedValue(null);
  vi.spyOn(ipc.api, "createVault").mockResolvedValue({ root: "/new", name: "New" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("preserves unavailable recent vaults and restores focus after a cancelled create", async () => {
  render(<SidebarHeader vault={vault} />);
  const button = screen.getByRole("button", { name: "Vault" });
  fireEvent.click(button);
  await waitFor(() => expect(useUi.getState().menu).not.toBeNull());
  expect(useUi.getState().menu!.items.find((item) => item.label === "Other")?.disabled).toBe(true);
  act(() => {
    const create = useUi.getState().menu!.items.find((item) => item.label === "Create new vault…")!;
    useUi.getState().hideMenu();
    create.action!();
  });
  await waitFor(() => expect(useUi.getState().askText).toHaveBeenCalled());
  await waitFor(() => expect(document.activeElement).toBe(button));
  expect(ipc.api.createVault).not.toHaveBeenCalled();
});

test("keeps open/create actions available when recent vaults fail to load", async () => {
  vi.mocked(ipc.api.recentVaults).mockRejectedValueOnce(new Error("Recents unavailable"));
  render(<SidebarHeader vault={vault} />);
  fireEvent.click(screen.getByRole("button", { name: "Vault" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Recents unavailable");
  expect(useUi.getState().menu!.items.map((item) => item.label)).toContain("Open folder as vault…");
});

test("ignores a late recent-vault response after the vault changes", async () => {
  let finish!: (items: typeof recent) => void;
  vi.mocked(ipc.api.recentVaults).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<SidebarHeader vault={vault} />);
  fireEvent.click(screen.getByRole("button", { name: "Vault" }));
  expect(screen.getByRole("button", { name: "Hide sidebar" })).toHaveProperty("disabled", true);
  act(() => useVault.setState({ vault: { root: "/different", name: "Different" } }));
  await act(async () => finish(recent));
  expect(useUi.getState().menu).toBeNull();
});
