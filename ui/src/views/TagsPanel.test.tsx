// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { TagsPanel } from "./TagsPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("tag errors remain distinct from empty loads and can be retried", async () => {
  vi.spyOn(api, "tags")
    .mockRejectedValueOnce(new Error("Tag index unavailable"))
    .mockResolvedValueOnce([{ tag: "project/active", count: 3 }]);
  render(<TagsPanel />);
  expect(screen.getByRole("status").textContent).toContain("Loading");
  expect((await screen.findByRole("alert")).textContent).toContain("Tag index unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry tags" }));
  const tag = await screen.findByRole("button", { name: "Search #project/active · 3 notes" });
  expect(document.activeElement).toBe(tag);
  fireEvent.click(tag);
  expect(useUi.getState().searchQuery).toBe("tag:project/active");
});

test("a late tag result cannot overwrite a newer revision", async () => {
  let resolve!: (value: { tag: string; count: number }[]) => void;
  vi.spyOn(api, "tags")
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce([]);
  render(<TagsPanel />);
  act(() => useVault.setState({ revision: useVault.getState().revision + 1 }));
  await screen.findByText("No tags yet. Add #tags to your notes.");
  await act(async () => resolve([{ tag: "old", count: 1 }]));
  expect(screen.queryByRole("button", { name: /#old/ })).toBeNull();
});
