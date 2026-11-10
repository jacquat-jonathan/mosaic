// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import { useIndexHealth, startIndexHealth } from "../state/indexHealth";
import { useVault } from "../state/vault";
import { IndexHealthNotice } from "./IndexHealthNotice";
import type { IndexHealth } from "../ipc/types";
const degraded: IndexHealth = {
  status: "degraded",
  watching: false,
  diagnostic: { problem: "watcher_start", error_code: "io", occurred_at_ms: 1 },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useIndexHealth.setState({ vault: null, health: null, error: null, requested: false });
});
test("degraded indexing stays visible and rebuild requests are serialized without reopening notes", async () => {
  const vault = { root: "/vault", name: "Vault" };
  useVault.setState({ vault });
  useIndexHealth.setState({ vault, health: degraded });
  let finish!: () => void;
  const rebuild = vi.spyOn(api, "rebuildIndex").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(null);
      }),
  );
  const open = vi.spyOn(api, "openVault");
  render(<IndexHealthNotice />);
  expect(screen.getByRole("alert").textContent).toContain("Your notes are still available");
  fireEvent.click(screen.getByRole("button", { name: "Rebuild search index" }));
  fireEvent.click(screen.getByRole("button", { name: "Requesting rebuild…" }));
  expect(rebuild).toHaveBeenCalledExactlyOnceWith("/vault");
  expect(open).not.toHaveBeenCalled();
  await act(async () => {
    finish();
  });
  act(() => useIndexHealth.setState({ health: { status: "healthy", watching: true, diagnostic: null } }));
  expect(screen.queryByRole("region")).toBeNull();
});
test("old vault health results and notifications cannot replace current health", async () => {
  const a = { root: "/a", name: "A" },
    b = { root: "/b", name: "B" };
  useVault.setState({ vault: a });
  let finishA!: (health: IndexHealth) => void;
  vi.spyOn(api, "indexHealth").mockImplementation((root) =>
    root === "/a"
      ? new Promise((resolve) => {
          finishA = resolve;
        })
      : Promise.resolve({ status: "healthy", watching: true, diagnostic: null }),
  );
  const stop = await startIndexHealth();
  useVault.setState({ vault: b });
  await Promise.resolve();
  finishA(degraded);
  window.dispatchEvent(new CustomEvent("mock-index-health", { detail: { root: "/a", health: degraded } }));
  await Promise.resolve();
  expect(useIndexHealth.getState().vault).toBe(b);
  expect(useIndexHealth.getState().health?.status).toBe("healthy");
  window.dispatchEvent(new CustomEvent("mock-index-health", { detail: { root: "/b", health: degraded } }));
  expect(useIndexHealth.getState().health?.status).toBe("degraded");
  stop();
});
test("rebuild failure is displayed and a stale failure does not leak after switching", async () => {
  const vault = { root: "/vault", name: "Vault" };
  useVault.setState({ vault });
  useIndexHealth.setState({ vault, health: degraded });
  vi.spyOn(api, "rebuildIndex").mockRejectedValue(new Error("reconnect required"));
  render(<IndexHealthNotice />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Rebuild search index" }));
  });
  expect(screen.getByText("reconnect required")).toBeTruthy();
  act(() => useVault.setState({ vault: { root: "/other", name: "Other" } }));
  expect(screen.queryByRole("region")).toBeNull();
});
