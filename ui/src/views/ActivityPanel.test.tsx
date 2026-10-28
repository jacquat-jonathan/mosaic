// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../ipc/api";
import type { Proposal, Version } from "../ipc/types";
import { useReview } from "../state/review";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { ActivityPanel } from "./ActivityPanel";
vi.mock("./ReviewModal", () => ({
  proposalWho: (proposal: Proposal) => proposal.actor || "An agent",
  ReviewModal: ({ onClose }: { onClose(): void }) => (
    <div role="dialog">
      <button onClick={onClose}>Close review</button>
    </div>
  ),
}));
const version = (id: number, action = "edited"): Version => ({
  id,
  path: `Notes/Note ${id}.md`,
  time: 1000 + id,
  source: "agent",
  actor: "Claude",
  action,
  hash: "hash",
  size: 10,
  from_path: null,
});
const proposal = (id: number, created: number) =>
  ({
    id,
    path: `Notes/Proposal ${id}.md`,
    created,
    updated: created,
    action: "edited",
    stale: id === 1,
    actor: "Claude",
  }) as Proposal;
beforeEach(() => {
  useVault.setState({ vault: { root: "/vault", name: "Vault" } });
  useReview.setState({ initialized: true, pending: [] });
  useUi.setState({ history: null });
  vi.spyOn(ipc, "onVaultChanged").mockResolvedValue(vi.fn());
  vi.spyOn(ipc.api, "aiActivity").mockResolvedValue([version(1), version(2, "deleted")]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("keeps oldest reviews before newest applied changes and restores review focus", async () => {
  useReview.setState({ pending: [proposal(2, 20), proposal(1, 10)] });
  render(<ActivityPanel />);
  const reviews = screen.getByRole("region", { name: "Waiting for your review" });
  const applied = screen.getByRole("region", { name: "Applied changes" });
  const reviewRows = within(reviews).getAllByRole("listitem");
  expect(reviewRows[0].textContent).toContain("Proposal 1");
  expect(reviewRows[0].textContent).toContain("File changed since proposal");
  await screen.findByRole("button", { name: "Note 1" });
  expect(within(applied).getAllByRole("listitem")[0].textContent).toContain("Note 2");
  expect(screen.getByRole("button", { name: "Note 2" })).toHaveProperty("disabled", true);
  const review = within(reviewRows[0]).getByRole("button", { name: "Review" });
  fireEvent.click(review);
  expect(screen.getByRole("dialog").closest(".mosaic-ds")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close review" }));
  expect(document.activeElement).toBe(review);
});

test("retries failed loading and ignores a late response from the previous vault", async () => {
  vi.mocked(ipc.api.aiActivity).mockRejectedValueOnce(new Error("History unavailable"));
  render(<ActivityPanel />);
  expect((await screen.findByRole("alert")).textContent).toContain("History unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
  expect(await screen.findByRole("button", { name: "Note 1" })).toBeTruthy();
  let finish!: (items: Version[]) => void;
  vi.mocked(ipc.api.aiActivity)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce([]);
  const listener = vi.mocked(ipc.onVaultChanged).mock.calls[0][0];
  act(() => listener({ paths: [], kind: "changed" } as never));
  act(() => useVault.setState({ vault: { root: "/other", name: "Other" } }));
  await act(async () => finish([version(99)]));
  expect(screen.queryByRole("button", { name: "Note 99" })).toBeNull();
  expect(await screen.findByText(/No changes by AI agents yet/)).toBeTruthy();
});

test("serializes undo, announces conflicts and retains history as recovery", async () => {
  let reject!: (error: unknown) => void;
  vi.spyOn(ipc.api, "undoChange")
    .mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValueOnce("Notes/Note 1.md");
  render(<ActivityPanel />);
  const row = (await screen.findByRole("button", { name: "Note 1" })).closest(".mds-change-row")! as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Undo" }));
  expect(
    screen.getAllByRole("button", { name: /Undo/ }).every((button) => (button as HTMLButtonElement).disabled),
  ).toBe(true);
  await act(async () => reject({ code: "conflict" }));
  expect(screen.getByRole("alert").textContent).toContain("Open its history to pick a version");
  fireEvent.click(within(row).getByRole("button", { name: "File history" }));
  expect(useUi.getState().history?.path).toBe("Notes/Note 1.md");
  act(() => useUi.getState().closeHistory());
  expect(document.activeElement).toBe(within(row).getByRole("button", { name: "File history" }));
  fireEvent.click(within(row).getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(within(row).getByRole("button", { name: "Undone" })).toHaveProperty("disabled", true));
  expect(document.activeElement).toBe(within(row).getByRole("button", { name: "File history" }));
});
