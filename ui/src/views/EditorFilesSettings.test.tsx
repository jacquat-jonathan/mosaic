// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import { DEFAULT_VAULT_PREFS, useVaultPreferences } from "../state/vaultPreferences";
import { EditorFilesSettings } from "./EditorFilesSettings";

const policy = () => screen.getByRole("switch", { name: "Allow scripts in HTML previews" });
const reset = () => screen.getByRole("button", { name: "Reset Allow scripts in HTML previews" });

beforeEach(() => useVaultPreferences.setState({ root: "/vault", value: DEFAULT_VAULT_PREFS, error: null }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useVaultPreferences.setState({ root: null, value: DEFAULT_VAULT_PREFS, error: null });
});

test("HTML policy disables both actions until the vault write completes", async () => {
  const user = userEvent.setup();
  let finish!: () => void;
  const pending = new Promise<null>((resolve) => {
    finish = () => resolve(null);
  });
  const save = vi.spyOn(api, "setVaultPreferences").mockReturnValue(pending);
  vi.spyOn(api, "vaultPreferences").mockResolvedValue({ ...DEFAULT_VAULT_PREFS, allow_html_scripts: true });
  render(<EditorFilesSettings />);
  await user.click(policy());
  expect(save).toHaveBeenCalledWith("/vault", { allow_html_scripts: true });
  expect(policy()).toHaveProperty("disabled", true);
  expect(reset()).toHaveProperty("disabled", true);
  expect(screen.getByRole("status").textContent).toBe("Saving HTML preview policy…");
  await user.click(reset());
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  await waitFor(() => expect(policy().getAttribute("aria-checked")).toBe("true"));
  expect(policy()).toHaveProperty("disabled", false);
  expect(reset()).toHaveProperty("disabled", false);
});

test("a failed policy save keeps its value and exposes an associated retryable error", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "setVaultPreferences").mockRejectedValue(new Error("Write failed"));
  render(<EditorFilesSettings />);
  await user.click(policy());
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Write failed");
  expect(policy().getAttribute("aria-checked")).toBe("false");
  expect(policy()).toHaveProperty("disabled", false);
  const descriptions = policy().getAttribute("aria-describedby")!.split(" ");
  expect(descriptions.some((id) => document.getElementById(id)?.textContent === "Write failed")).toBe(true);
});

test("missing or unreadable vault preferences disable policy edits", async () => {
  useVaultPreferences.setState({ root: null });
  render(<EditorFilesSettings />);
  expect(policy()).toHaveProperty("disabled", true);
  expect(reset()).toHaveProperty("disabled", true);
  expect(screen.getByRole("switch", { name: "Spellcheck" })).toHaveProperty("disabled", false);
  act(() => useVaultPreferences.setState({ root: "/vault", error: "Cannot read vault preferences" }));
  expect(screen.getByRole("alert").textContent).toBe("Cannot read vault preferences");
  expect(policy()).toHaveProperty("disabled", true);
  expect(reset()).toHaveProperty("disabled", true);
});
