// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import { hasDraft, leaveDraft } from "../state/drafts";
import { useAttention } from "../state/attention";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { DEFAULT_VAULT_PREFS, useVaultPreferences } from "../state/vaultPreferences";
import { WorkflowForm } from "./WorkflowForm";

beforeEach(() => {
  useAttention.setState({ agents: [], refresh: vi.fn().mockResolvedValue(undefined) });
  useVault.setState({
    vault: { root: "/vault", name: "Vault", history_warning: null },
    entries: [],
    refresh: vi.fn().mockResolvedValue(undefined),
  });
  useVaultPreferences.setState({ root: "/vault", value: DEFAULT_VAULT_PREFS, error: null });
  useUi.setState({ ask: vi.fn().mockResolvedValue(false), openView: vi.fn() });
  vi.spyOn(api, "create").mockResolvedValue({ path: "Agents/Review.md", hash: "created" });
  vi.spyOn(api, "mirrorAgents").mockResolvedValue({ written: [], removed: [], skipped: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function fill() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Name"), "Review");
  await user.type(screen.getByLabelText("Instructions"), "Summarize the vault");
  return user;
}

test("invalid fields receive focus and their associated explanation", async () => {
  const user = userEvent.setup();
  render(<WorkflowForm />);
  await user.click(screen.getByRole("button", { name: "Create workflow" }));
  expect(document.activeElement).toBe(screen.getByLabelText("Instructions"));
  expect(screen.getByLabelText("Instructions").getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByRole("alert").textContent).toContain("Describe what the agent should do");
  await user.type(screen.getByLabelText("Instructions"), "Summarize");
  await user.click(screen.getByRole("button", { name: "Create workflow" }));
  expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  expect(api.create).not.toHaveBeenCalled();
});

test("switch-only edits participate in draft confirmation", async () => {
  const user = userEvent.setup();
  render(<WorkflowForm />);
  await user.click(screen.getByRole("switch", { name: "Run on a schedule" }));
  expect(hasDraft("mosaic:new-workflow")).toBe(true);
  expect(await leaveDraft("mosaic:new-workflow")).toBe(false);
  expect(useUi.getState().ask).toHaveBeenCalledWith(expect.objectContaining({ title: "Discard workflow changes?" }));
});

test("pending saves disable edits and stop later effects if the vault changes", async () => {
  let finish!: () => void;
  vi.mocked(api.create).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ path: "Agents/Review.md", hash: "created" });
      }),
  );
  const done = vi.fn();
  render(<WorkflowForm onDone={done} />);
  const user = await fill();
  await user.click(screen.getByRole("button", { name: "Create workflow" }));
  expect(screen.getByLabelText("Instructions").matches(":disabled")).toBe(true);
  expect(screen.getByRole("switch", { name: "Run on a schedule" }).matches(":disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
  expect(await leaveDraft("mosaic:new-workflow")).toBe(false);
  expect(useUi.getState().ask).not.toHaveBeenCalled();
  expect(api.create).toHaveBeenCalledWith("Agents/Review.md", expect.any(String), "/vault");
  act(() => useVault.setState({ vault: { root: "/other", name: "Other", history_warning: null } }));
  await act(async () => finish());
  expect(api.mirrorAgents).not.toHaveBeenCalled();
  expect(done).not.toHaveBeenCalled();
});

test("failed saves retain the draft and a retry completes without running the workflow", async () => {
  vi.mocked(api.create).mockRejectedValueOnce(new Error("Write refused"));
  const run = vi.spyOn(api, "tesseraRun");
  const done = vi.fn();
  render(<WorkflowForm onDone={done} />);
  const user = await fill();
  await user.click(screen.getByRole("button", { name: "Create workflow" }));
  expect(screen.getByRole("alert").textContent).toBe("Write refused");
  expect(screen.getByLabelText("Instructions")).toHaveProperty("value", "Summarize the vault");
  expect(hasDraft("mosaic:new-workflow")).toBe(true);
  await user.click(screen.getByRole("button", { name: "Create workflow" }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(run).not.toHaveBeenCalled();
  expect(hasDraft("mosaic:new-workflow")).toBe(false);
});
