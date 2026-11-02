// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AgentRun, TesseraStatus, VaultInfo } from "../ipc/types";
import { api } from "../ipc/api";
import { startAttention, useAttention } from "../state/attention";
import { useReview } from "../state/review";
import { useVault } from "../state/vault";
import { DestinationNavigation } from "./DestinationNavigation";
import { RunsHistory } from "./RunsHistory";

const failedRun: AgentRun = {
  id: 42,
  agent: "example",
  title: "Example workflow",
  started: 1_798_000_000,
  finished: 1_798_000_100,
  late: false,
  status: "failed",
  answer: "",
  error: "The test run failed",
  proposals: 0,
};
const status: TesseraStatus = { paused: false, max_chain_depth: 5, agents: [], runs: [failedRun] };

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  useVault.setState({ vault: { root: "/test-vault" } as VaultInfo });
  useReview.setState({ pending: [] });
  useAttention.setState({ root: "/test-vault", status, agents: [], error: null, unseenFailureIds: [42] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("opening All runs clears its failed-run badge while keeping the new failure highlighted", async () => {
  render(
    <>
      <DestinationNavigation />
      <RunsHistory />
    </>,
  );
  const row = screen.getByRole("row", { name: /Example workflow/ });
  await waitFor(() => expect(row.getAttribute("data-new-failure")).toBe("true"));
  expect(row.textContent).toContain("Failed");
  expect(row.textContent).toContain("New");
  expect(screen.getByRole("tab", { name: "AI" }).querySelector(".destination-attention")).toBeNull();
  expect(JSON.parse(localStorage.getItem("mosaic:seen-failed-runs:/test-vault") ?? "[]")).toEqual([42]);
  act(() => useAttention.setState({ unseenFailureIds: [43] }));
  expect(screen.getByRole("tab", { name: "AI" }).querySelector(".destination-attention")?.textContent).toBe("1");
});

test("a seen failed run stays seen after attention restarts", async () => {
  vi.spyOn(api, "tesseraStatus").mockResolvedValue(status);
  const stop = startAttention("/test-vault");
  try {
    await waitFor(() => expect(useAttention.getState().unseenFailureIds).toEqual([42]));
    act(() => useAttention.getState().markFailuresSeen([42]));
    expect(useAttention.getState().unseenFailureIds).toEqual([]);
  } finally {
    stop();
  }
  const stopAgain = startAttention("/test-vault");
  try {
    await waitFor(() => expect(useAttention.getState().status?.runs).toHaveLength(1));
    expect(useAttention.getState().unseenFailureIds).toEqual([]);
  } finally {
    stopAgain();
  }
});
