// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
const mocks = vi.hoisted(() => ({ query: vi.fn(), setTask: vi.fn(), off: vi.fn() }));
vi.mock("../ipc/api", async (original) => ({
  ...(await original<typeof import("../ipc/api")>()),
  api: { ...(await original<typeof import("../ipc/api")>()).api, query: mocks.query, setTask: mocks.setTask },
  onVaultChanged: vi.fn(async () => mocks.off),
}));
import { renderQuery } from "./queryBlock";
import { useVault } from "../state/vault";
import type { QueryResult } from "../ipc/types";
const result: QueryResult = {
  columns: [],
  total: 1,
  rows: [
    {
      path: "Tasks.md",
      title: "Tasks",
      modified: 1,
      tags: [],
      props: {},
      task: {
        line: 2,
        text: "Write report",
        status: "open",
        mark: " ",
        depth: 0,
        parent: null,
        due: null,
        workflow: "new",
      },
    },
  ],
};
const root = () => useVault.setState({ vault: { ...useVault.getState().vault!, root: "/vault" } });
afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  vi.resetAllMocks();
});
test("query errors retain a working reload action and clean up the watcher", async () => {
  root();
  mocks.query.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(result);
  const el = document.body.appendChild(document.createElement("div"));
  await renderQuery("task:open", el);
  expect(el.querySelector('[role="alert"]')?.textContent).toContain("offline");
  fireEvent.click(el.querySelector("button")!);
  await waitFor(() => expect(el.querySelector(".query-task-box")).not.toBeNull());
  expect(el.getAttribute("aria-busy")).toBe("false");
  el.remove();
  await waitFor(() => expect(mocks.off).toHaveBeenCalledOnce());
});
test("task updates serialize and restore the result after a rejected write", async () => {
  root();
  mocks.query.mockResolvedValue(result);
  let fail!: (error: Error) => void;
  mocks.setTask.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const el = document.body.appendChild(document.createElement("div"));
  await renderQuery("task:open", el);
  const box = el.querySelector<HTMLInputElement>("input")!;
  box.focus();
  box.checked = true;
  fireEvent.change(box);
  fireEvent.change(box);
  expect(box.disabled).toBe(true);
  expect(box.getAttribute("aria-busy")).toBe("true");
  expect(mocks.setTask).toHaveBeenCalledExactlyOnceWith("Tasks.md", 2, "Write report", true);
  fail(new Error("disk unavailable"));
  await waitFor(() => expect(el.querySelector('[role="alert"]')?.textContent).toContain("disk unavailable"));
  await waitFor(() => expect(el.querySelector<HTMLInputElement>("input")?.disabled).toBe(false));
  expect(el.querySelector<HTMLInputElement>("input")?.checked).toBe(false);
  expect(document.activeElement).toBe(el.querySelector("input"));
});
test("a late query response cannot paint results from a previous vault", async () => {
  root();
  let resolve!: (value: QueryResult) => void;
  mocks.query.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const el = document.body.appendChild(document.createElement("div"));
  const pending = renderQuery("task:open", el);
  useVault.setState({ vault: { ...useVault.getState().vault!, root: "/another" } });
  resolve(result);
  await pending;
  expect(el.querySelector(".query-table")).toBeNull();
});
