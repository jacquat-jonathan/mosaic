// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../ipc/api";
import type { MarkdownImportPreview } from "../../ipc/types";
import { useVault } from "../../state/vault";
import { MigrationWizard } from "./MigrationWizard";
const candidate = {
  source_path: "Plan.md",
  source_line: 2,
  block_id: null,
  fingerprint: "new",
  parent_fingerprint: null,
  epic_fingerprint: null,
  depth: 0,
  kind: "task" as const,
  title: "New task",
  status: "new" as const,
  due_date: null,
  all_day_session_date: null,
  archived: false,
  default_selected: true,
  duplicate: false,
};
const preview: MarkdownImportPreview = {
  planner_revision: 1,
  candidates: 2,
  selected_by_default: 1,
  duplicates: 1,
  groups: [
    {
      source_path: "Plan.md",
      tasks: [
        candidate,
        { ...candidate, fingerprint: "old", title: "Old task", duplicate: true, default_selected: false },
      ],
    },
  ],
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("Markdown preview keeps group/duplicate choices and retains selections after failure", async () => {
  let reject!: (reason: Error) => void;
  const save = vi.spyOn(api, "importMarkdownToPlanner").mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const cancel = vi.fn();
  render(<MigrationWizard preview={preview} onDone={vi.fn()} onCancel={cancel} />);
  const group = screen.getByRole("checkbox", { name: "Select all from Plan.md" });
  expect(screen.getByRole("checkbox", { name: "Old task" })).toHaveProperty("disabled", true);
  await userEvent.click(screen.getByRole("checkbox", { name: "Allow intentional duplicates" }));
  expect(group).toHaveProperty("indeterminate", true);
  await userEvent.click(screen.getByRole("checkbox", { name: "Old task" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "Allow intentional duplicates" }));
  expect(screen.getByRole("checkbox", { name: "Old task" })).toHaveProperty("checked", false);
  await userEvent.click(screen.getByRole("button", { name: "Import 1 items" }));
  await userEvent.click(screen.getByRole("button", { name: "Importing…" }));
  fireEvent.keyDown(screen.getByRole("region"), { key: "Escape" });
  expect(cancel).not.toHaveBeenCalled();
  expect(save).toHaveBeenCalledTimes(1);
  reject(new Error("import failed"));
  expect(await screen.findByText("import failed")).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "New task" })).toHaveProperty("checked", true);
});
test("late Markdown import acknowledgements cannot change another vault", async () => {
  let finish!: () => void;
  vi.spyOn(api, "importMarkdownToPlanner").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({ planner_revision: 2, imported_epic_ids: [], imported_task_ids: ["new"], skipped_duplicates: [] });
      }),
  );
  const done = vi.fn();
  render(<MigrationWizard preview={preview} onDone={done} onCancel={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Import 1 items" }));
  useVault.setState({ vault: { root: "/other", name: "Other" } });
  finish();
  await waitFor(() => expect(done).not.toHaveBeenCalled());
});
