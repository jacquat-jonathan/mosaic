// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import type { Agent } from "../ipc/types";
import { useChat, type ChatItem } from "../state/chat";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { ChatPanel } from "./ChatPanel";
import { ChatContext } from "./ChatContext";

let id: string;
const agent: Agent = {
  name: "weekly",
  title: "Weekly review",
  description: "Review notes",
  path: "Agents/Weekly.md",
  skill_folder: false,
  schedule: null,
  on: [],
  model: null,
  may_change: [],
  web: false,
  instructions: "Review",
};
const user: ChatItem = { kind: "user", text: "Summarize", agent: null, context: [], selection: null, model: null };
beforeEach(() => {
  localStorage.clear();
  useChat.setState({ root: "/vault", chats: {}, storageError: null });
  useVault.setState({
    vault: { root: "/vault", name: "Vault" },
    entries: [{ path: "Ideas.md", name: "Ideas.md", is_dir: false, kind: "markdown", size: 10, mtime: 1 }],
  });
  useWorkspace.setState({ panes: [{ id: "main", active: null, tabs: [] }], focused: "main" });
  useUi.setState({ picker: null, prompt: null });
  id = useChat.getState().create();
  vi.spyOn(api, "chatCheck").mockResolvedValue({ path: "/bin/claude", version: "1" });
  vi.spyOn(api, "agents").mockResolvedValue([agent]);
  vi.spyOn(useChat.getState(), "send").mockResolvedValue();
  vi.spyOn(useChat.getState(), "stop").mockImplementation(() => {});
  vi.spyOn(useWorkspace.getState(), "open").mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("preserves Enter, multiline and composition rules and sends an agent without extra text", async () => {
  render(<ChatPanel id={id} />);
  const input = await screen.findByLabelText("Message to Claude");
  fireEvent.change(input, { target: { value: "Draft" } });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(useChat.getState().send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(useChat.getState().send).toHaveBeenCalledWith(id, "Draft", [], null, null, null, null);
  fireEvent.click(screen.getByRole("button", { name: "Weekly review" }));
  expect(document.activeElement).toBe(input);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(useChat.getState().send).toHaveBeenLastCalledWith(id, "Go ahead.", [], null, "weekly", null, null);
});

test("retains drafts while running, disables model changes and stops the right chat", async () => {
  useChat.getState().update(id, { run: 7, draft: "Next message", items: [user] });
  render(<ChatPanel id={id} />);
  const input = await screen.findByLabelText("Message to Claude");
  expect(input).toHaveProperty("disabled", false);
  expect(screen.getByLabelText("Chat model")).toHaveProperty("disabled", true);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(useChat.getState().send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(useChat.getState().stop).toHaveBeenCalledWith(id);
  expect(useChat.getState().chats[id].draft).toBe("Next message");
});

test("returns focus from attachment picking and ignores a stale vault selection", async () => {
  render(<ChatPanel id={id} />);
  const attach = await screen.findByRole("button", { name: "Attach a note" });
  fireEvent.click(attach);
  act(() => {
    useUi.getState().closePicker();
  });
  expect(document.activeElement).toBe(attach);
  fireEvent.click(attach);
  const picked = useUi.getState().picker!;
  act(() => {
    picked.onPick(picked.items[0]);
    useUi.getState().closePicker();
  });
  expect(useChat.getState().chats[id].attached).toEqual(["Ideas.md"]);
  fireEvent.click(screen.getByRole("button", { name: "Detach Ideas" }));
  expect(useChat.getState().chats[id].attached).toEqual([]);
  fireEvent.click(attach);
  const picker = useUi.getState().picker!;
  act(() => {
    useVault.setState({ vault: { root: "/other", name: "Other" } });
    useChat.setState({ root: "/other" });
  });
  act(() => picker.onPick(picker.items[0]));
  expect(useChat.getState().chats[id].attached).toEqual([]);
});

test("pins serialized saved-note writes and ignores navigation after a vault switch", async () => {
  useChat.getState().update(id, { items: [user, { kind: "text", text: "Answer" }] });
  let finish!: () => void;
  vi.spyOn(api, "create").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ path: "Saved.md", hash: "hash", review: null });
      }),
  );
  render(<ChatPanel id={id} />);
  const save = await screen.findByRole("button", { name: "Save as note" });
  fireEvent.click(save);
  expect(save).toHaveProperty("disabled", true);
  expect(api.create).toHaveBeenCalledWith(
    expect.stringContaining("/Chats/"),
    expect.stringContaining("Answer"),
    "/vault",
  );
  fireEvent.click(save);
  expect(api.create).toHaveBeenCalledTimes(1);
  act(() => {
    useVault.setState({ vault: { root: "/other", name: "Other" } });
    useChat.setState({ root: "/other" });
  });
  await act(async () => finish());
  expect(useWorkspace.getState().open).not.toHaveBeenCalled();
});

test("shows retryable connection errors and context file failures", async () => {
  vi.mocked(api.chatCheck).mockRejectedValueOnce(new Error("Connection unavailable"));
  useChat.getState().update(id, { attached: ["Ideas.md"] });
  const { rerender } = render(<ChatPanel id={id} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Connection unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry connection check" }));
  expect(await screen.findByLabelText("Message to Claude")).toBeTruthy();
  vi.mocked(useWorkspace.getState().open).mockRejectedValueOnce(new Error("File unavailable"));
  rerender(<ChatContext id={id} />);
  fireEvent.click(screen.getByRole("button", { name: "Ideas.md" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("File unavailable"));
});
