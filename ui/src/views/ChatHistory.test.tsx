// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useChat } from "../state/chat";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { ChatHistoryPage } from "./ChatHistory";

beforeEach(() => {
  localStorage.clear();
  useVault.setState({ vault: { root: "/vault", name: "Vault" } });
  useChat.setState({ root: "/vault", chats: {}, storageError: null });
  useWorkspace.setState({ panes: [{ id: "main", tabs: [], active: null }], focused: "main" });
  useUi.setState({
    menu: null,
    prompt: null,
    confirm: null,
    openView: vi.fn(),
    showChat: vi.fn(),
    ask: vi.fn().mockResolvedValue(true),
    askText: vi.fn().mockResolvedValue("Renamed"),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function add(title: string, updated = Date.now()) {
  const id = useChat.getState().create();
  useChat.getState().update(id, { title, updated });
  return id;
}
function menuAction(label: string) {
  useUi.getState().menu!.items.find((item) => item.label === label)!.action!();
}

test("groups newest chats, collapses older ones and preserves selected navigation", () => {
  const now = Date.now();
  const first = add("First", now - 1000),
    second = add("Second", now),
    older = add("Older chat", now - 10 * 86400000);
  useWorkspace.setState({ panes: [{ id: "main", tabs: [`mosaic:chat/${second}`], active: `mosaic:chat/${second}` }] });
  render(<ChatHistoryPage />);
  const today = screen.getByText("Today").closest("details")!;
  expect(
    within(today)
      .getAllByRole("button")
      .filter((button) => button.hasAttribute("data-chat-open"))
      .map((button) => button.textContent),
  ).toEqual(["Second", "First"]);
  expect(screen.getByRole("button", { name: "Second" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByText("Older").closest("details")!.open).toBe(false);
  fireEvent.click(screen.getByText("Older"));
  fireEvent.click(screen.getByRole("button", { name: "Older chat" }));
  expect(useUi.getState().openView).toHaveBeenCalledWith("chat", older);
  expect(useChat.getState().chats[first]).toBeTruthy();
});

test("returns focus after rename and deletion and closes deleted chat tabs", async () => {
  const id = add("Conversation");
  useWorkspace.setState({
    panes: [{ id: "main", tabs: [`mosaic:chat/${id}`, "mosaic:chats"], active: "mosaic:chats" }],
  });
  const close = vi.spyOn(useWorkspace.getState(), "closeTab");
  render(<ChatHistoryPage />);
  fireEvent.click(screen.getByRole("button", { name: "Actions for Conversation" }));
  act(() => {
    menuAction("Rename");
    useUi.setState({ menu: null });
  });
  await waitFor(() => expect(useChat.getState().chats[id].title).toBe("Renamed"));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Actions for Renamed" })));
  fireEvent.click(screen.getByRole("button", { name: "Actions for Renamed" }));
  act(() => {
    menuAction("Delete chat");
    useUi.setState({ menu: null });
  });
  await waitFor(() => expect(useChat.getState().chats[id]).toBeUndefined());
  expect(close).toHaveBeenCalledWith("main", `mosaic:chat/${id}`);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "New chat" })));
});

test("ignores pending rename and deletion decisions after switching vaults", async () => {
  const id = add("Conversation");
  let finish!: (value: string | null) => void;
  vi.mocked(useUi.getState().askText).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<ChatHistoryPage />);
  fireEvent.click(screen.getByRole("button", { name: "Actions for Conversation" }));
  act(() => menuAction("Rename"));
  act(() => {
    useVault.setState({ vault: { root: "/other", name: "Other" } });
    useChat.setState({ root: "/other" });
  });
  await act(async () => finish("Stale rename"));
  expect(useChat.getState().chats[id].title).toBe("Conversation");
  act(() => {
    useVault.setState({ vault: { root: "/vault", name: "Vault" } });
    useChat.setState({ root: "/vault" });
  });
  let accept!: (value: boolean) => void;
  vi.mocked(useUi.getState().ask).mockImplementation(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Actions for Conversation" }));
  act(() => menuAction("Delete chat"));
  act(() => {
    useVault.setState({ vault: { root: "/other", name: "Other" } });
    useChat.setState({ root: "/other" });
  });
  await act(async () => accept(true));
  expect(useChat.getState().chats[id]).toBeTruthy();
});

test("shows storage failures, empty history and new chat action", () => {
  useChat.setState({ storageError: "App storage is full" });
  render(<ChatHistoryPage />);
  expect(screen.getByRole("alert").textContent).toBe("App storage is full");
  expect(screen.getByText("Your saved conversations appear here.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  expect(useUi.getState().showChat).toHaveBeenCalled();
});
