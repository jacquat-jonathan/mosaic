// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import type { Proposal } from "../ipc/types";
import { useVault } from "../state/vault";
import { useReview } from "../state/review";
import { useWorkspace } from "../state/workspace";
import { proposalWhat, proposalWho, ReviewModal } from "./ReviewModal";

const proposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  id: 7,
  path: "Notes/Plan.md",
  action: "edited",
  status: "pending",
  source: "mcp",
  actor: "Claude",
  created: Date.now() - 2_000,
  updated: Date.now() - 1_000,
  decided: null,
  reason: null,
  base_hash: "base",
  hash: "proposed",
  stale: false,
  binary: false,
  to_path: null,
  update_links: false,
  ...overrides,
});

function mockContents(current: string | null, proposed: string | null) {
  vi.spyOn(api, "proposalContent").mockResolvedValue(proposed);
  const read = vi.spyOn(api, "read");
  if (current === null) read.mockRejectedValue({ code: "not_found", message: "missing" });
  else
    read.mockResolvedValue({
      path: "Notes/Plan.md",
      content: current,
      hash: "current",
      kind: "markdown",
      size: current.length,
      mtime: Date.now(),
    });
}

beforeEach(() => {
  useVault.setState({ vault: { root: "/vault", name: "Vault" } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("describes every proposal source and action", () => {
  expect(proposalWho(proposal())).toBe("Claude");
  expect(proposalWho(proposal({ actor: null, source: "cli" }))).toBe("mosaic command");
  expect(proposalWho(proposal({ actor: null, source: "mcp" }))).toBe("an agent");
  expect(["created", "deleted", "renamed", "edited"].map((action) => proposalWhat(proposal({ action })))).toEqual([
    "wants to create",
    "wants to delete",
    "wants to rename",
    "wants to change",
  ]);
});

test("accepts only the selected edit hunks and opens the resulting note", async () => {
  const user = userEvent.setup();
  mockContents("one\nold\ntwo\nthree\nremove\nfour\n", "one\nnew\ntwo\nthree\nfour\nextra\n");
  const accept = vi.spyOn(api, "acceptProposal").mockResolvedValue("Notes/Plan.md");
  const refresh = vi.spyOn(useReview.getState(), "refresh").mockResolvedValue();
  const open = vi.spyOn(useWorkspace.getState(), "open").mockResolvedValue();
  const close = vi.fn();
  render(<ReviewModal proposal={proposal()} onClose={close} />);

  const hunks = await screen.findAllByRole("checkbox", { name: /Accept change/ });
  expect(hunks.length).toBeGreaterThan(1);
  await user.click(hunks[0]);
  const acceptSome = screen.getByRole("button", { name: /Accept \d+ of \d+/ });
  await user.click(acceptSome);

  await waitFor(() => expect(accept).toHaveBeenCalled());
  expect(accept).toHaveBeenCalledWith(7, false, expect.any(String));
  expect(accept.mock.calls[0][2]).toContain("old");
  expect(refresh).toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  expect(open).toHaveBeenCalledWith("Notes/Plan.md", { newTab: false });
});

test("recovers from a stale conflict, compares the human edit, and accepts anyway", async () => {
  const user = userEvent.setup();
  mockContents("now\nkept by me\n", "then\nchanged by agent\n");
  vi.spyOn(api, "proposalBase").mockResolvedValue("then\noriginal\n");
  const accept = vi
    .spyOn(api, "acceptProposal")
    .mockRejectedValueOnce({ code: "conflict", message: "changed", current_hash: "new" })
    .mockResolvedValueOnce("Notes/Plan.md");
  vi.spyOn(useReview.getState(), "refresh").mockResolvedValue();
  vi.spyOn(useWorkspace.getState(), "open").mockResolvedValue();
  render(<ReviewModal proposal={proposal()} onClose={vi.fn()} />);

  await user.click(await screen.findByRole("button", { name: "Accept" }));
  expect((await screen.findByRole("alert")).textContent).toContain("changed after the agent proposed");
  await user.click(await screen.findByRole("radio", { name: "What changed since" }));
  expect(screen.getByText("kept by me")).toBeTruthy();
  await user.click(screen.getByRole("radio", { name: "What accepting does" }));
  await user.click(screen.getByRole("button", { name: "Accept anyway" }));
  await waitFor(() => expect(accept).toHaveBeenLastCalledWith(7, true, null));
});

test("rejects with trimmed feedback after displaying a recoverable error", async () => {
  const user = userEvent.setup();
  mockContents("old", "new");
  const reject = vi
    .spyOn(api, "rejectProposal")
    .mockRejectedValueOnce(new Error("history unavailable"))
    .mockResolvedValueOnce(null);
  vi.spyOn(useReview.getState(), "refresh").mockResolvedValue();
  const close = vi.fn();
  render(<ReviewModal proposal={proposal()} onClose={close} />);

  await user.click(screen.getByRole("button", { name: "Reject…" }));
  const reason = screen.getByPlaceholderText("e.g. keep the old wording");
  await user.type(reason, "  Keep my examples.  ");
  await user.click(screen.getByRole("button", { name: /^Reject$/ }));
  expect(await screen.findByText("history unavailable")).toBeTruthy();
  expect(reject).toHaveBeenLastCalledWith(7, "Keep my examples.");

  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.click(screen.getByRole("button", { name: "Reject…" }));
  await user.click(screen.getByRole("button", { name: /^Reject$/ }));
  await waitFor(() => expect(close).toHaveBeenCalled());
});

test("renders rename, binary deletion, and text creation-specific review states", async () => {
  mockContents("old", "new");
  const renamed = render(
    <ReviewModal
      proposal={proposal({ action: "renamed", to_path: "Archive/Plan.md", update_links: true })}
      onClose={vi.fn()}
    />,
  );
  expect(await screen.findByText(/links will follow/)).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  renamed.unmount();
  vi.restoreAllMocks();

  mockContents("binary", null);
  const binary = render(
    <ReviewModal proposal={proposal({ action: "deleted", binary: true, hash: null })} onClose={vi.fn()} />,
  );
  expect(await screen.findByText("Binary files do not have a text diff.")).toBeTruthy();
  expect(screen.getByText(/moves this binary file to the Trash/)).toBeTruthy();
  binary.unmount();
  vi.restoreAllMocks();

  mockContents(null, "brand new");
  render(<ReviewModal proposal={proposal({ action: "created", base_hash: null })} onClose={vi.fn()} />);
  expect(await screen.findByText("brand new")).toBeTruthy();
  expect(screen.getByText(/Accepting creates the file/)).toBeTruthy();
});

test("serializes decisions and refuses Escape or close while acceptance is pending", async () => {
  const user = userEvent.setup();
  mockContents("old", "new");
  let finish!: () => void;
  const accept = vi.spyOn(api, "acceptProposal").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve("Notes/Plan.md");
      }),
  );
  vi.spyOn(useReview.getState(), "refresh").mockResolvedValue();
  vi.spyOn(useWorkspace.getState(), "open").mockResolvedValue();
  const close = vi.fn();
  render(<ReviewModal proposal={proposal()} onClose={close} />);
  await user.click(await screen.findByRole("button", { name: "Accept" }));
  expect(screen.getByRole("button", { name: "Accepting…" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Close dialog" })).toHaveProperty("disabled", true);
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
  expect(accept).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
});

test("retries failed comparisons without enabling acceptance of an unread file", async () => {
  const user = userEvent.setup();
  mockContents("old", "new");
  vi.mocked(api.read).mockRejectedValueOnce(new Error("Read denied"));
  render(<ReviewModal proposal={proposal()} onClose={vi.fn()} />);
  expect(await screen.findByText("Read denied")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Accept" })).toHaveProperty("disabled", true);
  await user.click(screen.getByRole("button", { name: "Retry comparison" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Accept" })).toHaveProperty("disabled", false));
});

test("does not repeat an accepted change when opening its file fails", async () => {
  const user = userEvent.setup();
  mockContents("old", "new");
  const accept = vi.spyOn(api, "acceptProposal").mockResolvedValue("Notes/Plan.md");
  vi.spyOn(useReview.getState(), "refresh").mockResolvedValue();
  vi.spyOn(useWorkspace.getState(), "open").mockRejectedValue(new Error("Unavailable"));
  render(<ReviewModal proposal={proposal()} onClose={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "Accept" }));
  expect((await screen.findByRole("alert")).textContent).toContain("The change was accepted");
  expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  expect(accept).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Close" })).toHaveProperty("disabled", false);
});
