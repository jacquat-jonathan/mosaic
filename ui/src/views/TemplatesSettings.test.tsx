// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import type { TemplateConfig } from "../ipc/types";
import { useVault } from "../state/vault";
import { defaultTemplateConfig } from "../templates";
import { TemplatesSettings } from "./TemplatesSettings";

let stored: TemplateConfig;
beforeEach(() => {
  stored = defaultTemplateConfig();
  useVault.setState({
    vault: { root: "/vault", name: "Vault", history_warning: null },
    revision: 1,
    entries: [{ path: "Templates", name: "Templates", is_dir: true, kind: null, size: 0, mtime: 0 }],
  });
  vi.spyOn(api, "templateConfig").mockImplementation(async () => stored);
  vi.spyOn(api, "setTemplateConfig").mockImplementation(async (next) => {
    stored = next;
    return null;
  });
  vi.spyOn(api, "templates").mockResolvedValue({ templates: [], default: { template: null, rule_folder: null } });
  vi.spyOn(api, "templateStarters").mockResolvedValue([
    ["Meeting.md", "# {{title}}\n\nDate: {{date}}"],
    ["Project.md", "# Project"],
  ]);
  vi.spyOn(api, "mkdir").mockResolvedValue(null);
  vi.spyOn(useVault.getState(), "refresh").mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("repair stages a draft and failed saves preserve it for retry", async () => {
  const user = userEvent.setup();
  vi.mocked(api.templateConfig).mockRejectedValueOnce(new Error("Cannot load template settings"));
  vi.mocked(api.setTemplateConfig).mockRejectedValueOnce(new Error("Cannot save template settings"));
  render(<TemplatesSettings />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Cannot load template settings");
  await user.click(screen.getByRole("button", { name: "Repair template settings" }));
  const folder = screen.getByLabelText("Templates folder");
  expect(api.setTemplateConfig).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(folder);
  await user.clear(folder);
  await user.type(folder, "CustomTemplates");
  await user.click(screen.getByRole("button", { name: "Save template settings" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Cannot save template settings");
  expect(folder).toHaveProperty("value", "CustomTemplates");
  await user.click(screen.getByRole("button", { name: "Save template settings" }));
  expect(await screen.findByText("Template settings saved for this vault.")).toBeTruthy();
  expect(stored).toMatchObject({ folder: "CustomTemplates", rules: [] });
  expect(api.mkdir).not.toHaveBeenCalled();
});

test("template-list retry does not overwrite an unsaved folder draft", async () => {
  const user = userEvent.setup();
  vi.mocked(api.templates).mockRejectedValueOnce(new Error("Template list unavailable"));
  render(<TemplatesSettings />);
  await screen.findByLabelText("Templates folder");
  const available = screen.getByRole("region", { name: "Available templates" });
  expect(await within(available).findByRole("alert")).toHaveProperty(
    "textContent",
    "Template list unavailable Refresh templates",
  );
  await user.clear(screen.getByLabelText("Templates folder"));
  await user.type(screen.getByLabelText("Templates folder"), "MyTemplates");
  await user.click(within(available).getByRole("button", { name: "Refresh templates" }));
  await waitFor(() => expect(api.templates).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText("Templates folder")).toHaveProperty("value", "MyTemplates");
  expect(api.setTemplateConfig).not.toHaveBeenCalled();
});

test("starter preview cancels without writes and installation keeps existing files", async () => {
  const user = userEvent.setup();
  const create = vi.spyOn(api, "create").mockImplementation(async (path) => {
    if (path.endsWith("Meeting.md")) throw { code: "already_exists", message: "Existing template" };
    return { path, hash: "created" };
  });
  render(<TemplatesSettings />);
  const preview = await screen.findByRole("button", { name: "Preview starter templates" });
  await user.click(preview);
  let panel = await screen.findByRole("region", { name: "Starter template previews" });
  await user.click(within(panel).getByText("Meeting.md"));
  expect(within(panel).getByText(/Date: \{\{date\}\}/)).toBeTruthy();
  expect(create).not.toHaveBeenCalled();
  await user.click(within(panel).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(preview));
  expect(create).not.toHaveBeenCalled();
  await user.click(preview);
  panel = await screen.findByRole("region", { name: "Starter template previews" });
  await user.click(within(panel).getByRole("button", { name: "Add starter templates" }));
  await screen.findByText("Kept existing Meeting.md · Added Project.md");
  expect(create).toHaveBeenCalledWith("Templates/Meeting.md", "# {{title}}\n\nDate: {{date}}", "/vault");
  expect(create).toHaveBeenCalledWith("Templates/Project.md", "# Project", "/vault");
  await waitFor(() => expect(document.activeElement).toBe(preview));
});

test("an install awaiting folder creation stops when the vault changes", async () => {
  const user = userEvent.setup();
  useVault.setState({ entries: [] });
  let finish!: () => void;
  const pending = new Promise<null>((resolve) => {
    finish = () => resolve(null);
  });
  vi.mocked(api.mkdir).mockReturnValueOnce(pending);
  const create = vi.spyOn(api, "create");
  render(<TemplatesSettings />);
  await user.click(await screen.findByRole("button", { name: "Preview starter templates" }));
  await user.click(screen.getByRole("button", { name: "Add starter templates" }));
  expect(screen.getByRole("button", { name: "Add folder default" })).toHaveProperty("disabled", true);
  act(() => useVault.setState({ vault: { root: "/other", name: "Other", history_warning: null } }));
  await act(async () => finish());
  expect(create).not.toHaveBeenCalled();
});
