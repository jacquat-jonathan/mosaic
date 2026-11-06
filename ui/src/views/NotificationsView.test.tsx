// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AgentRun, TesseraStatus } from "../ipc/types";
import { useAttention } from "../state/attention";
import { loadSeen, startNotifications, useNotifications } from "../state/notifications";
import { useReview } from "../state/review";
import { useUi } from "../state/ui";
import { NotificationsView } from "./NotificationsView";

const failed: AgentRun = {
  id: 42,
  agent: "example",
  title: "Example workflow",
  started: Date.now() / 1000 - 100,
  finished: Date.now() / 1000 - 50,
  late: false,
  status: "failed",
  answer: "",
  error: "It broke",
  proposals: 0,
};
const status = (runs: AgentRun[]): TesseraStatus => ({ paused: false, max_chain_depth: 3, agents: [], runs });
let stop = () => {};

beforeEach(() => {
  localStorage.clear();
  useReview.setState({ pending: [] });
  useAttention.setState({ status: status([failed]) });
  stop = startNotifications("/v");
});
afterEach(() => {
  stop();
  cleanup();
  vi.restoreAllMocks();
});

test("derives from review and run state and updates when they change", () => {
  expect(useNotifications.getState().unreadCount()).toBe(1);
  useAttention.setState({ status: status([]) });
  expect(useNotifications.getState().unreadCount()).toBe(0);
});

test("opening marks read and navigates to the run", () => {
  const openView = vi.fn();
  useUi.setState({ openView });
  render(<NotificationsView />);
  fireEvent.click(screen.getByRole("button", { name: /Example workflow failed/ }));
  expect(openView).toHaveBeenCalledWith("run", "42");
  expect(useNotifications.getState().unreadCount()).toBe(0);
  expect(screen.queryByRole("img", { name: "Unread" })).toBeNull();
});

test("dismissing hides it, persists per vault, and survives a restart", () => {
  render(<NotificationsView />);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.getByText(/all caught up/)).toBeTruthy();
  expect(loadSeen("/v").dismissed).toEqual(["workflow-failed:42"]);
  expect(loadSeen("/other").dismissed).toEqual([]);
  stop();
  stop = startNotifications("/v");
  expect(useNotifications.getState().visible()).toEqual([]);
});

test("mark all read and clear all", () => {
  useAttention.setState({ status: status([failed, { ...failed, id: 43 }]) });
  render(<NotificationsView />);
  fireEvent.click(screen.getByRole("button", { name: /Mark all read/ }));
  expect(useNotifications.getState().unreadCount()).toBe(0);
  expect(useNotifications.getState().visible()).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
  expect(useNotifications.getState().visible()).toHaveLength(0);
});

test("corrupt storage falls back to empty", () => {
  localStorage.setItem("mosaic:notifications:/v", "{not json");
  expect(loadSeen("/v")).toEqual({ read: [], dismissed: [] });
});
