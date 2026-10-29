// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import type { TemplatePreview } from "../ipc/types";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { NewNoteDialog } from "./NewNoteDialog";

const list = {
  templates: [
    { path: "Templates/Meeting.md", name: "Meeting" },
    { path: "Templates/Project.md", name: "Project" },
  ],
  default: { template: "Templates/Meeting.md", rule_folder: "Work" },
};

const preview = (path: string, content = "# {{title}}"): TemplatePreview => ({
  path,
  content,
  template: "Templates/Meeting.md",
  template_hash: "template-hash",
  rule_folder: "Work",
  context: {
    title: path.replace(/\.md$/, "").split("/").pop() ?? "",
    date: "2026-10-27",
    time: "20:00",
    weekday: "Tuesday",
    timestamp: "2026-10-27T20:00:00+01:00",
  },
});

beforeEach(() => {
  useUi.setState({ newNote: { dir: "Work", root: "/vault", name: "Draft", newTab: true } });
  useVault.setState({
    vault: { root: "/vault", name: "Vault", history_warning: null },
    entries: [
      { path: "Work", name: "Work", is_dir: true, kind: null, size: 0, mtime: 0 },
      { path: "Work/Existing.md", name: "Existing.md", is_dir: false, kind: "markdown", size: 1, mtime: 0 },
    ],
    revision: 4,
    selected: new Set(),
  });
  vi.spyOn(api, "templates").mockResolvedValue(list);
  vi.spyOn(api, "renderTemplate").mockImplementation(async (request) => ({
    ...preview(request.path, request.blank ? "" : `# ${request.path}`),
    template: request.blank ? null : (request.template ?? "Templates/Meeting.md"),
    template_hash: request.blank ? null : "template-hash",
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useUi.setState({ newNote: null });
});

test("validates, filters templates, and creates the exact previewed note", async () => {
  const user = userEvent.setup();
  const create = vi.spyOn(api, "createNote").mockResolvedValue({
    path: "Work/Final.md",
    hash: "new",
    template: null,
    rule_folder: null,
  });
  const refresh = vi.spyOn(useVault.getState(), "refresh").mockResolvedValue();
  const reveal = vi.spyOn(useVault.getState(), "revealParents");
  const select = vi.spyOn(useVault.getState(), "setSelection");
  const open = vi.spyOn(useWorkspace.getState(), "open").mockResolvedValue();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  render(<NewNoteDialog />);

  expect(await screen.findByText(/default from Work/)).toBeTruthy();
  const name = screen.getByLabelText("Name");
  await user.clear(name);
  await user.type(name, "Existing");
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "“Work/Existing.md” already exists. Choose another name.",
  );
  await user.clear(name);
  await user.type(name, "bad/name");
  expect(screen.getByRole("alert").textContent).toContain("without slashes");

  await user.clear(name);
  await user.type(name, "Final");
  await user.type(screen.getByLabelText("Find templates"), "project");
  const template = screen.getByLabelText("Template");
  expect([...template.querySelectorAll("option")].map((option) => option.textContent)).toContain(
    "Templates/Project.md",
  );
  expect([...template.querySelectorAll("option")].map((option) => option.textContent)).not.toContain(
    "Templates/Meeting.md",
  );
  await user.selectOptions(template, "blank");
  expect(await screen.findByText("Empty note")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Create" }));

  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      path: "Work/Final.md",
      template: null,
      blank: true,
      expected_template_hash: null,
    }),
  );
  expect(refresh).toHaveBeenCalled();
  expect(reveal).toHaveBeenCalledWith("Work/Final.md");
  expect(select).toHaveBeenCalledWith(["Work/Final.md"]);
  expect(open).toHaveBeenCalledWith("Work/Final.md", { newTab: true });
  expect(useUi.getState().newNote).toBeNull();
  vi.unstubAllGlobals();
});

test("reports a preview failure and refreshes it without losing the note details", async () => {
  const user = userEvent.setup();
  vi.mocked(api.templates).mockRejectedValueOnce(new Error("template index unavailable"));
  vi.mocked(api.renderTemplate).mockRejectedValueOnce(new Error("preview unavailable"));
  render(<NewNoteDialog />);

  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "preview unavailable");
  expect(screen.getByText("Choose another template or refresh the preview.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Refresh preview" }));
  expect(await screen.findByText("# Work/Draft.md")).toBeTruthy();
  expect(api.templates).toHaveBeenCalledTimes(2);
  expect(api.renderTemplate).toHaveBeenCalledTimes(2);
});

test("closes on Escape and discards a dialog that belongs to another vault", async () => {
  const user = userEvent.setup();
  const view = render(<NewNoteDialog />);
  await screen.findByRole("dialog", { name: "New note" });
  await user.keyboard("{Escape}");
  expect(useUi.getState().newNote).toBeNull();

  useUi.setState({ newNote: { dir: "", root: "/old-vault", name: "Note", newTab: false } });
  view.rerender(<NewNoteDialog />);
  await waitFor(() => expect(useUi.getState().newNote).toBeNull());
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("pending creation blocks dismissal and duplicate writes, then preserves failed drafts", async () => {
  let fail!: (error: Error) => void;
  const create = vi.spyOn(api, "createNote").mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  render(<NewNoteDialog />);
  await screen.findByText("# Work/Draft.md");
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(screen.getByLabelText("Name")).toHaveProperty("disabled", true);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  fireEvent.submit(screen.getByLabelText("Name").closest("form")!);
  expect(useUi.getState().newNote).not.toBeNull();
  expect(create).toHaveBeenCalledOnce();
  await act(async () => fail(new Error("creation failed")));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "creation failed");
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "Draft");
});
