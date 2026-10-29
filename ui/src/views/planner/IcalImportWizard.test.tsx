// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../ipc/api";
import type { IcalImportPreview } from "../../ipc/types";
import { IcalImportWizard } from "./IcalImportWizard";
const event = {
  title: "Planning",
  description: "",
  location: "",
  meeting_url: null,
  participants: [],
  epic_id: null,
  color: null,
  all_day: true,
  start_value: "2026-11-12",
  end_value: "2026-11-13",
  timezone: "UTC",
  recurrence_rule: null,
};
const preview: IcalImportPreview = {
  planner_revision: 1,
  source_kind: "ics-file",
  duplicates: 1,
  candidates: [
    {
      key: "new",
      source_uid: "new",
      recurrence_id: "",
      title: "New planning",
      all_day: true,
      start_value: "2026-11-12",
      end_value: "2026-11-13",
      timezone: "UTC",
      recurrence_rule: null,
      duplicate: false,
      event,
    },
    {
      key: "duplicate",
      source_uid: "old",
      recurrence_id: "",
      title: "Old planning",
      all_day: true,
      start_value: "2026-11-12",
      end_value: "2026-11-13",
      timezone: "UTC",
      recurrence_rule: null,
      duplicate: true,
      event,
    },
  ],
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("iCalendar selection keeps duplicates explicit and failed imports retain selections", async () => {
  let reject!: (reason: Error) => void;
  const save = vi.spyOn(api, "importPlannerIcal").mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  render(<IcalImportWizard preview={preview} fileName="plan.ics" onDone={vi.fn()} onCancel={vi.fn()} />);
  const duplicate = screen.getByRole("checkbox", { name: /Old planning/ });
  expect(duplicate).toHaveProperty("disabled", true);
  await userEvent.click(screen.getByRole("checkbox", { name: "Allow intentional duplicates" }));
  await userEvent.click(duplicate);
  await userEvent.click(screen.getByRole("checkbox", { name: "Allow intentional duplicates" }));
  expect(duplicate).toHaveProperty("checked", false);
  await userEvent.click(screen.getByRole("button", { name: "Import 1 events" }));
  await userEvent.click(screen.getByRole("button", { name: "Importing…" }));
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith(preview, ["new"], false);
  reject(new Error("import failed"));
  expect(await screen.findByText("import failed")).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: /New planning/ })).toHaveProperty("checked", true);
});
