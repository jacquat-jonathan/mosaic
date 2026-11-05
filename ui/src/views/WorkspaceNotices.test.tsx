// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useVault } from "../state/vault";
import { WorkspaceNotices } from "./WorkspaceNotices";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("workspace reconnection serializes and keeps the preserving-workspace option explicit", async () => {
  useVault.setState({ vault: { root: "/vault", name: "Vault" }, offline: true, unfinishedRenames: [] });
  let finish!: () => void;
  const open = vi.spyOn(useVault.getState(), "openVault").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<WorkspaceNotices />);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  fireEvent.click(screen.getByRole("button", { name: "Reconnecting…" }));
  expect(open).toHaveBeenCalledExactlyOnceWith("/vault", { preserveWorkspace: true });
  expect(screen.getByRole("button", { name: "Reconnecting…" })).toHaveProperty("disabled", true);
  await act(async () => {
    useVault.setState({ offline: false });
    finish();
  });
  expect(screen.queryByRole("region")).toBeNull();
});
