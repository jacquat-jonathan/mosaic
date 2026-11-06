import { expect, test } from "vitest";
import { readProps, removeProp, renameProp, setProp, withProperties } from "./properties";

const yaml =
  "# a comment\ntags: [project, mosaic]\ndue: 2026-10-02\ndone: false\ncount: 3\ntitle: Plan\nmeta: {a: 1}\n";

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

test("setting a property on an empty frontmatter block reuses it", () => {
  for (const eol of ["\n", "\r\n"]) {
    const note = `---${eol}---${eol}# Title${eol}`;
    const out = withProperties(note, setProp("", "status", "draft"));
    expect(out).toBe(`---${eol}status: draft${eol}---${eol}# Title${eol}`);
    expect(out.match(/^---/gm)).toHaveLength(2);
  }
  // No trailing newline after the closing fence.
  expect(withProperties("---\n---", setProp("", "a", 1))).toBe("---\na: 1\n---");
  // Clearing the last property leaves an empty block rather than a blank-line one.
  expect(withProperties("---\na: 1\n---\nbody", "")).toBe("---\n---\nbody");
  // No frontmatter yet: a block is added once.
  expect(withProperties("# T\n", "a: 1\n")).toBe("---\na: 1\n---\n\n# T\n");
});
