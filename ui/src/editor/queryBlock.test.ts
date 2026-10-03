import { expect, test } from "vitest";
import { cell, isTaskQuery, queryTable } from "./queryBlock";
import type { QueryRow } from "../ipc/types";

const row: QueryRow = {
  path: "Projects/Alpha.md",
  title: "Alpha",
  modified: new Date(2026, 9, 2, 14, 5).getTime(),
  tags: ["project", "app"],
  props: { Status: "active", owners: ["Anna", "Ben"], priority: 2, meta: { a: 1 } },
};

test("cells show fields as text", () => {
  expect(cell(row, "status")).toBe("active");
  expect(cell(row, "owners")).toBe("Anna, Ben");
  expect(cell(row, "priority")).toBe("2");
  expect(cell(row, "meta")).toBe('{"a":1}');
  expect(cell(row, "missing")).toBe("");
  expect(cell(row, "tags")).toBe("#project #app");
  expect(cell(row, "modified")).toBe("2026-10-02 14:05");
});

test("the table links each note and says when results were cut", () => {
  const html = queryTable({ columns: ["status"], rows: [row], total: 3 });
  expect(html).toContain('data-target="Projects/Alpha"');
  expect(html).toContain("<td>active</td>");
  expect(html).toContain("1 of 3 shown");
  expect(queryTable({ columns: [], rows: [], total: 0 })).toContain("No matching notes");
});

test("task queries show tickable tasks, nested, with their note", () => {
  const task = (line: number, status: "open" | "done" | "moved", text: string, depth = 0) => ({
    ...row,
    task: { line, status, mark: status === "done" ? "x" : status === "moved" ? ">" : " ", text, depth, parent: depth ? 2 : null, due: null },
  });
  const html = queryTable({ columns: [], rows: [task(2, "open", "Write <report>"), task(3, "done", "Outline", 1), task(4, "moved", "Old")], total: 3 });
  expect(html).toContain("<th>Task</th>");
  expect(html).toContain('data-line="2" data-text="Write &lt;report&gt;"');
  expect(html).toMatch(/checked[^>]*data-line="3"/);
  expect(html).toContain("padding-left:18px");
  expect(html).toMatch(/disabled[^>]*data-line="4"/);
  expect(html).toContain('data-target="Projects/Alpha"');
  expect(cell(task(3, "done", "Outline"), "status")).toBe("done");
  expect(queryTable({ columns: [], rows: [], total: 0 }, true)).toContain("No matching tasks");
  expect(isTaskQuery("folder:Daily task:open")).toBe(true);
  expect(isTaskQuery("tag:project")).toBe(false);
});
