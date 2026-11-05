// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import { useSettings } from "../state/settings";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { DEFAULT_VAULT_PREFS, useVaultPreferences } from "../state/vaultPreferences";
import { WorkspaceSettings } from "./WorkspaceSettings";

beforeEach(() => {
  useSettings.setState({ startup: "note" });
  useUi.setState({ picker: null });
  useVault.setState({ vault: { root: "/vault", name: "Vault", history_warning: null }, entries: [] });
  useVaultPreferences.setState({
    root: "/vault",
    value: { ...DEFAULT_VAULT_PREFS, startup_note: "Missing.md" },
    error: null,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("a stale startup-note picker cannot write to a different vault", async () => {
  const user = userEvent.setup();
  const save = vi.spyOn(api, "setVaultPreferences");
  render(<WorkspaceSettings />);
  await user.click(screen.getByRole("button", { name: "Startup note" }));
  const picker = useUi.getState().picker!;
  act(() => {
    useVault.setState({ vault: { root: "/other", name: "Other", history_warning: null } });
    useVaultPreferences.setState({ root: "/other", value: DEFAULT_VAULT_PREFS });
  });
  act(() => picker.onPick({ id: "", label: "None" }));
  expect(save).not.toHaveBeenCalled();
});

test("a failed startup-note reset keeps the note and restores focus for retry", async () => {
  const user = userEvent.setup();
  let fail!: (reason: Error) => void;
  const save = vi.spyOn(api, "setVaultPreferences").mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  render(<WorkspaceSettings />);
  const reset = screen.getByRole("button", { name: "Reset Startup note" });
  await user.click(reset);
  expect(save).toHaveBeenCalledWith("/vault", { startup_note: "" });
  expect(reset).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Startup note" })).toHaveProperty("disabled", true);
  await act(async () => fail(new Error("Save refused")));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Save refused");
  expect(screen.getByRole("button", { name: "Startup note" }).textContent).toContain("Missing.md");
  await waitFor(() => expect(document.activeElement).toBe(reset));
});
