// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import { useVault } from "../state/vault";
import { DEFAULT_VAULT_PREFS, useVaultPreferences } from "../state/vaultPreferences";
import { CalendarLinksSettings } from "./CalendarLinksSettings";

beforeEach(() => {
  useVault.setState({ vault: { root: "/vault", name: "Vault", history_warning: null } });
  useVaultPreferences.setState({ root: "/vault", value: DEFAULT_VAULT_PREFS, error: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("vault choices serialize writes and keep the saved value after a failure", async () => {
  const user = userEvent.setup();
  let fail!: (reason: Error) => void;
  const save = vi.spyOn(api, "setVaultPreferences").mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  render(<CalendarLinksSettings />);
  const format = screen.getByLabelText("Daily file name");
  await user.selectOptions(format, "YYYYMMDD");
  expect(save).toHaveBeenCalledWith("/vault", { daily_format: "YYYYMMDD" });
  expect(format).toHaveProperty("disabled", true);
  expect(screen.getByLabelText("New link syntax")).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Reset Daily file name" })).toHaveProperty("disabled", true);
  await act(async () => fail(new Error("Save failed")));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Save failed");
  expect(format).toHaveProperty("value", "YYYY-MM-DD");
  expect(format).toHaveProperty("disabled", false);
  expect(
    format
      .getAttribute("aria-describedby")
      ?.split(" ")
      .some((id) => document.getElementById(id)?.textContent === "Save failed"),
  ).toBe(true);
});

test("unavailable vault preferences disable edits while app controls remain available", () => {
  useVaultPreferences.setState({ error: "Cannot read vault settings" });
  render(<CalendarLinksSettings />);
  expect(screen.getByLabelText("Daily file name")).toHaveProperty("disabled", true);
  expect(screen.getByLabelText("New link syntax")).toHaveProperty("disabled", true);
  expect(screen.getByLabelText("Week starts on")).toHaveProperty("disabled", false);
  expect(screen.getByRole("switch", { name: "Open note links in a new tab" })).toHaveProperty("disabled", false);
  expect(screen.getByRole("button", { name: "Retry vault preferences" })).toBeTruthy();
});

test("pending saves do not carry errors or controls into another vault", async () => {
  const user = userEvent.setup();
  let finish!: () => void;
  vi.spyOn(api, "setVaultPreferences").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(null);
      }),
  );
  vi.spyOn(api, "vaultPreferences").mockResolvedValue({ ...DEFAULT_VAULT_PREFS, link_style: "markdown" });
  render(<CalendarLinksSettings />);
  await user.selectOptions(screen.getByLabelText("New link syntax"), "markdown");
  act(() => {
    useVault.setState({ vault: { root: "/other", name: "Other", history_warning: null } });
    useVaultPreferences.setState({ root: "/other", value: DEFAULT_VAULT_PREFS });
  });
  await act(async () => finish());
  expect(screen.getByLabelText("New link syntax")).toHaveProperty("value", "wiki");
  expect(screen.queryByRole("alert")).toBeNull();
});
