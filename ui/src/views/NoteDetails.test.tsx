// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import type { Backlink, Written } from "../ipc/types";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { NoteDetails } from "./NoteDetails";

beforeEach(() => {
  useVault.setState({ vault: { root: "/first", name: "First" }, entries: [], aliases: [], revision: 0 });
  useWorkspace.setState({
    buffers: {
      "Note.md": {
        path: "Note.md",
        kind: "markdown",
        content: "# Note\n",
        baseHash: "h",
        dirty: false,
        deleted: false,
        conflict: null,
        error: null,
        version: 1,
      },
    },
  });
  vi.spyOn(api, "backlinks").mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test("backlink failures remain distinct from empty results and retry restores focus", async () => {
  vi.mocked(api.backlinks).mockRejectedValueOnce(new Error("Backlink index unavailable"));
  render(<NoteDetails path="Note.md" />);
  expect((await screen.findByRole("alert")).textContent).toContain("Backlink index unavailable");
  expect(screen.queryByText("No other notes link here yet.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry backlinks" }));
  await screen.findByText("No other notes link here yet.");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: /^Backlinks/ })));
});

test("mention loads retry and link writes serialize while keeping the row until acknowledgement", async () => {
  vi.spyOn(api, "unlinkedMentions")
    .mockRejectedValueOnce(new Error("Mention index unavailable"))
    .mockResolvedValue([{ source: "Other.md", line: 2, text: "Note", context: "See Note." }]);
  let resolve!: (value: Written) => void;
  const write = vi.spyOn(api, "linkMention").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<NoteDetails path="Note.md" />);
  const toggle = screen.getByRole("button", { name: /Unlinked mentions/ });
  fireEvent.click(toggle);
  expect((await screen.findByRole("alert")).textContent).toContain("Mention index unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry mentions" }));
  const link = await screen.findByRole("button", { name: "Link" });
  // Safari pointer clicks may leave focus in the editor instead of moving it to the button.
  const editor = document.body.appendChild(document.createElement("input"));
  editor.focus();
  fireEvent.click(link);
  fireEvent.click(link);
  expect(write).toHaveBeenCalledOnce();
  expect((link as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Other" })).toBeTruthy();
  await act(async () => resolve({ path: "Other.md", hash: "written" }));
  await screen.findByText("No other notes mention this one without a link.");
  await waitFor(() => expect(document.activeElement).toBe(toggle));
});

test("a stale backlink response cannot replace a newer note", async () => {
  let resolve!: (value: Backlink[]) => void;
  vi.mocked(api.backlinks).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { rerender } = render(<NoteDetails path="Note.md" />);
  await waitFor(() => expect(api.backlinks).toHaveBeenCalledWith("Note.md"));
  rerender(<NoteDetails path="Other.md" />);
  await screen.findByText("No other notes link here yet.");
  await act(async () => resolve([{ source: "Stale.md", line: 1, context: "Old", embed: false }]));
  expect(screen.queryByRole("button", { name: "Stale" })).toBeNull();
});
