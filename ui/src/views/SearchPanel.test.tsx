// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import type { SearchHit } from "../ipc/types";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { SearchPanel } from "./SearchPanel";

const hit = (title: string): SearchHit => ({
  path: `Notes/${title}.md`,
  title,
  snippet: "Safe **match** <img src=x>",
  score: 1,
});
beforeEach(() => {
  useUi.setState({ searchQuery: "", searchFocus: 0 });
  useVault.setState({ vault: { root: "/vault", name: "Vault" }, bookmarks: [], indexing: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("search results preserve plain-text snippets, keyboard opening and Escape clearing", async () => {
  vi.spyOn(api, "search").mockResolvedValue([hit("Found")]);
  const open = vi.spyOn(useWorkspace.getState(), "open").mockResolvedValue();
  const { container } = render(<SearchPanel />);
  const input = screen.getByRole("textbox", { name: "Search notes" });
  fireEvent.change(input, { target: { value: "match" } });
  await screen.findByTitle("Notes/Found.md");
  expect(container.querySelector("mark")?.textContent).toBe("match");
  expect(container.querySelector("img")).toBeNull();
  fireEvent.keyDown(input, { key: "Enter", metaKey: true });
  expect(open).toHaveBeenCalledWith("Notes/Found.md", { newTab: true });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByTitle("Notes/Found.md")).toBeNull();
  expect(useUi.getState().searchQuery).toBe("");
});

test("search and bookmark failures retain retryable state", async () => {
  vi.spyOn(api, "search").mockRejectedValueOnce(new Error("Index unavailable")).mockResolvedValue([]);
  const save = vi.spyOn(api, "setBookmarks").mockRejectedValueOnce(new Error("Read only")).mockResolvedValue(null);
  render(<SearchPanel />);
  const input = screen.getByRole("textbox", { name: "Search notes" });
  fireEvent.change(input, { target: { value: "none" } });
  expect((await screen.findByRole("alert")).textContent).toContain("Index unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry search" }));
  await screen.findByText("No notes match this search.");
  expect(document.activeElement).toBe(input);
  fireEvent.click(screen.getByRole("button", { name: "Bookmark this search" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Read only");
  expect(useVault.getState().bookmarks).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Bookmark this search" }));
  await screen.findByRole("button", { name: "Remove this search from Bookmarks" });
  expect(save).toHaveBeenCalledTimes(2);
  expect(useVault.getState().bookmarks).toEqual(["search:none"]);
});

test("late search results cannot replace a newer query or open stale hits", async () => {
  let resolve!: (value: SearchHit[]) => void;
  const search = vi
    .spyOn(api, "search")
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue([hit("New")]);
  const open = vi.spyOn(useWorkspace.getState(), "open").mockResolvedValue();
  render(<SearchPanel />);
  const input = screen.getByRole("textbox", { name: "Search notes" });
  fireEvent.change(input, { target: { value: "old" } });
  await waitFor(() => expect(search).toHaveBeenCalledWith("old", 100));
  fireEvent.change(input, { target: { value: "new" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(open).not.toHaveBeenCalled();
  await screen.findByTitle("Notes/New.md");
  await act(async () => resolve([hit("Old")]));
  expect(screen.queryByTitle("Notes/Old.md")).toBeNull();
});

test("clearing a query during a bookmark save keeps acknowledged state without stealing focus", async () => {
  let resolve!: (value: null) => void;
  vi.spyOn(api, "search").mockResolvedValue([]);
  vi.spyOn(api, "setBookmarks").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<SearchPanel />);
  const input = screen.getByRole("textbox", { name: "Search notes" });
  fireEvent.change(input, { target: { value: "save me" } });
  fireEvent.click(screen.getByRole("button", { name: "Bookmark this search" }));
  input.focus();
  fireEvent.change(input, { target: { value: "" } });
  await act(async () => resolve(null));
  expect(useVault.getState().bookmarks).toEqual(["search:save me"]);
  expect(document.activeElement).toBe(input);
});
