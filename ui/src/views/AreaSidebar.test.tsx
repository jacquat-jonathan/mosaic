// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { AiSidebar } from "./AreaSidebar";
import { useUi } from "../state/ui";
import { useChat } from "../state/chat";
import { useAttention } from "../state/attention";
import { useReview } from "../state/review";
import { useWorkspace } from "../state/workspace";

beforeEach(() => {
  useUi.setState({ aiSection: "chats" });
  useChat.setState({ chats: {}, root: null });
  useAttention.setState({ agents: [], disconnected: false });
  useReview.setState({ pending: [] });
  useWorkspace.setState({ panes: [{ id: "test", tabs: [], active: null }], focused: "test" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("chat history cannot push automation navigation down the sidebar, and Manage is disclosed separately", () => {
  const id = useChat.getState().create();
  useChat.getState().update(id, { title: "Discuss the report" });
  const open = vi.spyOn(useWorkspace.getState(), "open").mockResolvedValue();
  render(<AiSidebar />);
  expect(screen.getByRole("button", { name: "Discuss the report" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "All runs" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Automations" }));
  expect(screen.queryByRole("button", { name: "Discuss the report" })).toBeNull();
  expect(screen.queryByRole("button", { name: "+ New chat" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "All runs" }));
  expect(open).toHaveBeenCalledWith("mosaic:runs", { newTab: true });
  expect(screen.getByText("Manage").closest("details")!.open).toBe(false);
  fireEvent.click(screen.getByText("Manage"));
  expect(screen.getByRole("button", { name: "Agent library" })).toBeTruthy();
});
test("activating an existing chat or run tab restores the matching sidebar section", () => {
  render(<AiSidebar />);
  act(() => useWorkspace.setState({ panes: [{ id: "test", tabs: ["mosaic:run/7"], active: "mosaic:run/7" }] }));
  expect(useUi.getState().aiSection).toBe("automations");
  expect(screen.getByRole("button", { name: "All runs" }).getAttribute("aria-current")).toBe("page");
  act(() => useWorkspace.setState({ panes: [{ id: "test", tabs: ["mosaic:chat/chat"], active: "mosaic:chat/chat" }] }));
  expect(useUi.getState().aiSection).toBe("chats");
});
