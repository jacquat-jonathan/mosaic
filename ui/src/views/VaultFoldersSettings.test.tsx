// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { DEFAULT_VAULT_PREFS, useVaultPreferences, type VaultPreferences } from "../state/vaultPreferences";
import { VaultFoldersSettings } from "./VaultFoldersSettings";

let saved: VaultPreferences;
beforeEach(() => {
  saved = {
    ...DEFAULT_VAULT_PREFS,
    allow_html_scripts: true,
    link_style: "markdown",
    daily_format: "DD-MM-YYYY",
    folder_colors: {},
  };
  useVault.setState({
    vault: { root: "/vault", name: "Vault", history_warning: null },
    entries: ["Agents", "Daily", "Projects"].map((path) => ({
      path,
      name: path,
      is_dir: true,
      kind: null,
      size: 0,
      mtime: 0,
    })),
  });
  useVaultPreferences.setState({ root: "/vault", value: saved, error: null });
  useUi.setState({ picker: null, prompt: null, confirm: null });
  vi.spyOn(api, "setVaultPreferences").mockImplementation(async (_root, patch) => {
    saved = { ...saved, ...patch };
    return null;
  });
  vi.spyOn(api, "vaultPreferences").mockImplementation(async () => saved);
  vi.spyOn(api, "mirrorAgents").mockResolvedValue({ written: [], removed: [], skipped: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useUi.setState({ picker: null, prompt: null, confirm: null });
});

test("folder saves serialize controls and refresh agent mirrors", async () => {
  const user = userEvent.setup();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.mocked(api.setVaultPreferences).mockImplementationOnce(async (_root, patch) => {
    await pending;
    saved = { ...saved, ...patch };
    return null;
  });
  render(<VaultFoldersSettings />);
  await user.click(screen.getByRole("button", { name: "Agents folder" }));
  const picker = useUi.getState().picker!;
  expect(picker.items.map((item) => item.id)).toEqual(["Agents", "Daily", "Projects"]);
  act(() => {
    useUi.getState().closePicker();
    picker.onPick({ id: "Projects", label: "Projects" });
  });
  expect(screen.getByRole("button", { name: "Reset Agents folder" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("combobox", { name: "New notes go in" })).toHaveProperty("disabled", true);
  await user.click(screen.getByRole("button", { name: "Reset Daily notes folder" }));
  expect(api.setVaultPreferences).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  await waitFor(() => expect(screen.getByRole("button", { name: "Agents folder" })).toHaveProperty("disabled", false));
  expect(api.setVaultPreferences).toHaveBeenCalledWith("/vault", { agents_folder: "Projects" });
  expect(api.mirrorAgents).toHaveBeenCalledTimes(1);
});

test("invalid folder paths leave the stored value intact and show an associated error", async () => {
  const user = userEvent.setup();
  vi.mocked(api.setVaultPreferences).mockRejectedValueOnce(new Error("Invalid folder path"));
  render(<VaultFoldersSettings />);
  await user.click(screen.getByRole("button", { name: "Set daily notes folder path" }));
  await act(async () => useUi.getState().answerText("../outside"));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Invalid folder path");
  const field = screen.getByRole("button", { name: "Daily notes folder" });
  expect(field.textContent).toBe("Daily…");
  expect(
    field
      .getAttribute("aria-describedby")!
      .split(" ")
      .some((id) => document.getElementById(id)?.textContent === "Invalid folder path"),
  ).toBe(true);
});

test("stale picker and confirmation callbacks do not write to another vault", async () => {
  const user = userEvent.setup();
  render(<VaultFoldersSettings />);
  await user.click(screen.getByRole("button", { name: "Daily notes folder" }));
  const picker = useUi.getState().picker!;
  act(() => {
    useUi.getState().closePicker();
    useVault.setState({ vault: { root: "/other", name: "Other", history_warning: null } });
    useVaultPreferences.setState({ root: "/other" });
    picker.onPick({ id: "Projects", label: "Projects" });
  });
  expect(api.setVaultPreferences).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Reset vault folders…" }));
  await act(async () => {
    useVault.setState({ vault: { root: "/third", name: "Third", history_warning: null } });
    useVaultPreferences.setState({ root: "/third" });
    useUi.getState().answer(true);
  });
  expect(api.setVaultPreferences).not.toHaveBeenCalled();
});

test("a missing folder is created only by its explicit action", async () => {
  const user = userEvent.setup();
  useVaultPreferences.setState({ value: { ...saved, daily_folder: "Journal" } });
  const mkdir = vi.spyOn(api, "mkdir").mockResolvedValue(null);
  vi.spyOn(useVault.getState(), "refresh").mockResolvedValue();
  render(<VaultFoldersSettings />);
  expect(mkdir).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Create daily notes folder" }));
  await waitFor(() => expect(mkdir).toHaveBeenCalledWith("Journal"));
  expect(api.setVaultPreferences).not.toHaveBeenCalled();
});

test("section reset preserves other vault preferences and supports cancellation", async () => {
  const user = userEvent.setup();
  saved = {
    ...saved,
    daily_folder: "Projects",
    new_note_location: "folder",
    new_note_folder: "Projects",
    folder_colors: { Projects: "purple" },
  };
  useVaultPreferences.setState({ value: saved });
  render(<VaultFoldersSettings />);
  await user.click(screen.getByRole("button", { name: "Reset vault folders…" }));
  await act(async () => useUi.getState().answer(false));
  expect(api.setVaultPreferences).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Reset vault folders…" }));
  await act(async () => useUi.getState().answer(true));
  await waitFor(() => expect(saved.daily_folder).toBe("Daily"));
  const patch = vi.mocked(api.setVaultPreferences).mock.calls[0][1];
  expect(Object.keys(patch).sort()).toEqual(
    [
      "agents_folder",
      "daily_folder",
      "daily_template",
      "new_note_location",
      "new_note_folder",
      "attachment_location",
      "attachment_folder",
      "show_attachments_in_tree",
      "folder_colors",
    ].sort(),
  );
  expect(saved).toMatchObject({
    allow_html_scripts: true,
    link_style: "markdown",
    daily_format: "DD-MM-YYYY",
    folder_colors: {},
  });
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reset vault folders…" })),
  );
});

test("repair retains the unreadable state when the backend refuses a newer version", async () => {
  const user = userEvent.setup();
  useVaultPreferences.setState({ error: "Cannot read vault preferences" });
  vi.mocked(api.setVaultPreferences).mockRejectedValueOnce(new Error("Newer-version preferences cannot be downgraded"));
  render(<VaultFoldersSettings />);
  expect(screen.getByRole("button", { name: "Daily notes folder" })).toHaveProperty("disabled", true);
  await user.click(screen.getByRole("button", { name: "Repair…" }));
  await act(async () => useUi.getState().answer(true));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Newer-version preferences cannot be downgradedRepair…",
  );
  expect(useVaultPreferences.getState().error).toBe("Cannot read vault preferences");
  expect(screen.getByRole("button", { name: "Daily notes folder" })).toHaveProperty("disabled", true);
});
