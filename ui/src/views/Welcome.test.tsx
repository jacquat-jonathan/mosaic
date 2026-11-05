// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../ipc/api";
import { useVault } from "../state/vault";
import { useUi } from "../state/ui";
import { Welcome } from "./Welcome";
beforeEach(() => {
  useVault.setState({ vault: null, error: null, openVault: vi.fn().mockResolvedValue(undefined) });
  vi.spyOn(ipc, "pickFolder").mockResolvedValue(null);
  vi.spyOn(useUi.getState(), "askText").mockResolvedValue("New vault");
  vi.spyOn(ipc.api, "createVault").mockResolvedValue({ root: "/parent/New vault", name: "New vault" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("serializes native picker actions and restores cancelled opener focus", async () => {
  let finish!: (path: string | null) => void;
  vi.mocked(ipc.pickFolder).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<Welcome />);
  const open = screen.getByRole("button", { name: "Open folder…" });
  fireEvent.click(open);
  expect(screen.getByRole("button", { name: "Create new vault…" })).toHaveProperty("disabled", true);
  fireEvent.click(open);
  expect(ipc.pickFolder).toHaveBeenCalledTimes(1);
  await act(async () => finish(null));
  expect(document.activeElement).toBe(open);
  expect(useVault.getState().openVault).not.toHaveBeenCalled();
});

test("opens existing vaults and retains open failures after the global toast clears", async () => {
  vi.mocked(ipc.pickFolder).mockResolvedValue("/vault");
  vi.mocked(useVault.getState().openVault).mockImplementation(async () => useVault.getState().setError("Open denied"));
  render(<Welcome />);
  fireEvent.click(screen.getByRole("button", { name: "Open folder…" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Open denied");
  expect(useVault.getState().openVault).toHaveBeenCalledWith("/vault");
  act(() => useVault.getState().setError(null));
  expect(screen.getByRole("alert").textContent).toBe("Open denied");
});

test("creates and opens a named vault and reports recoverable creation failures", async () => {
  vi.mocked(ipc.pickFolder).mockResolvedValue("/parent");
  vi.mocked(ipc.api.createVault).mockRejectedValueOnce(new Error("Folder exists"));
  render(<Welcome />);
  const create = screen.getByRole("button", { name: "Create new vault…" });
  fireEvent.click(create);
  expect((await screen.findByRole("alert")).textContent).toBe("Folder exists");
  expect(document.activeElement).toBe(create);
  fireEvent.click(create);
  await waitFor(() => expect(useVault.getState().openVault).toHaveBeenCalledWith("/parent/New vault"));
  expect(ipc.api.createVault).toHaveBeenLastCalledWith("/parent", "New vault");
});

test("ignores a late naming decision after another vault opens", async () => {
  vi.mocked(ipc.pickFolder).mockResolvedValue("/parent");
  let finish!: (name: string | null) => void;
  vi.mocked(useUi.getState().askText).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<Welcome />);
  fireEvent.click(screen.getByRole("button", { name: "Create new vault…" }));
  await waitFor(() => expect(useUi.getState().askText).toHaveBeenCalled());
  act(() => useVault.setState({ vault: { root: "/other", name: "Other" } }));
  await act(async () => finish("Stale vault"));
  expect(ipc.api.createVault).not.toHaveBeenCalled();
});

test("shows boot loading with disabled actions", () => {
  render(<Welcome loading />);
  expect(screen.getByRole("status").textContent).toBe("Opening Mosaic…");
  expect(screen.getAllByRole("button").every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
});
