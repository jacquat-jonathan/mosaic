import { expect, test } from "vitest";
import { readProps, removeProp, renameProp, setProp } from "./properties";

const yaml = "# a comment\ntags: [project, mosaic]\ndue: 2026-10-02\ndone: false\ncount: 3\ntitle: Plan\nmeta: {a: 1}\n";

test("reads each property with its kind", () => {
  expect(readProps(yaml).map((p) => [p.key, p.kind, p.value])).toEqual([
    ["tags", "list", ["project", "mosaic"]],
    ["due", "date", "2026-10-02"],
    ["done", "checkbox", false],
    ["count", "number", 3],
    ["title", "text", "Plan"],
    ["meta", "other", { a: 1 }],
  ]);
  expect(readProps("")).toEqual([]);
  expect(() => readProps("a: [")).toThrow();
});

test("changes one property and keeps the rest as written", () => {
  const out = setProp(yaml, "done", true);
  expect(out).toContain("# a comment");
  expect(out).toContain("done: true");
  expect(out).toContain("tags: [project, mosaic]");
  expect(out.indexOf("done")).toBeLessThan(out.indexOf("count"));
  expect(setProp(yaml, "tags", ["project", "mosaic", "ideas"])).toContain("tags: [project, mosaic, ideas]");
});

test("adds, renames and removes properties", () => {
  let out = setProp("title: Plan\n", "aliases", ["Roadmap"]);
  expect(out).toBe("title: Plan\naliases:\n  - Roadmap\n");
  out = renameProp(out, "title", "name");
  expect(out.startsWith("name: Plan\n")).toBe(true);
  expect(() => renameProp(out, "name", "aliases")).toThrow(/already/);
  expect(removeProp(out, "name")).toBe("aliases:\n  - Roadmap\n");
  expect(removeProp("a: 1\n", "a")).toBe("");
  expect(setProp("", "status", "draft")).toBe("status: draft\n");
});
