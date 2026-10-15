import { describe, expect, it } from "vitest";
import { insertSiblingSection, moveSection, moveSectionTo, parse, sectionRange, siblingLines } from "./outline";

const note = `---
title: Sections
---

# Note

Intro.

## Alpha

Alpha body.

### Alpha child

Child body.

## Beta

Beta body.

## Gamma

Gamma body.
`;

const lineOf = (text: string, heading: string) => text.split("\n").findIndex((line) => line === heading) + 1;

describe("Markdown note sections", () => {
  it("parses heading offsets outside frontmatter and fenced code", () => {
    const headings = parse(`${note}\n\`\`\`md\n## Not a section\n\`\`\`\n`);
    expect(headings.map(({ level, text }) => [level, text])).toEqual([
      [1, "Note"],
      [2, "Alpha"],
      [3, "Alpha child"],
      [2, "Beta"],
      [2, "Gamma"],
    ]);
    expect(note.slice(headings[1].offset)).toMatch(/^## Alpha/);
  });

  it("defines a parent section through all of its nested child sections", () => {
    const alpha = sectionRange(note, lineOf(note, "## Alpha"))!;
    expect(note.slice(alpha.from, alpha.to)).toContain("### Alpha child");
    expect(note.slice(alpha.from, alpha.to)).not.toContain("## Beta");
  });

  it("moves sibling sections with their children and preserves all source text", () => {
    const alphaLine = lineOf(note, "## Alpha");
    const betaLine = lineOf(note, "## Beta");
    expect(siblingLines(note, betaLine)).toEqual([alphaLine, betaLine, lineOf(note, "## Gamma")]);
    const moved = moveSection(note, betaLine, -1)!;
    expect(moved.text.indexOf("## Beta")).toBeLessThan(moved.text.indexOf("## Alpha"));
    expect(moved.text.indexOf("### Alpha child")).toBeGreaterThan(moved.text.indexOf("## Alpha"));
    expect(moved.text.replace(/## Beta[\s\S]*?Beta body\.\n\n/, "")).toBe(
      note.replace(/## Beta[\s\S]*?Beta body\.\n\n/, ""),
    );
  });

  it("allows pointer placement among siblings but refuses hierarchy-changing drops", () => {
    const alphaLine = lineOf(note, "## Alpha");
    const gammaLine = lineOf(note, "## Gamma");
    const childLine = lineOf(note, "### Alpha child");
    expect(moveSectionTo(note, gammaLine, alphaLine, "before")!.text.indexOf("## Gamma")).toBeLessThan(
      moveSectionTo(note, gammaLine, alphaLine, "before")!.text.indexOf("## Alpha"),
    );
    expect(moveSectionTo(note, childLine, gammaLine, "before")).toBeNull();
  });

  it("renumbers numbered sibling headings after they move", () => {
    const numbered = "# Plan\n\n## 1. First\n\nA.\n\n## 2. Second\n\nB.\n\n## 3) Third\n\nC.\n";
    const changed = moveSectionTo(
      numbered,
      lineOf(numbered, "## 3) Third"),
      lineOf(numbered, "## 1. First"),
      "before",
    )!;
    expect(parse(changed.text).map((heading) => heading.text)).toEqual(["Plan", "1) Third", "2. First", "3. Second"]);
    expect(changed.text.slice(changed.focus)).toMatch(/^## 1\) Third/);
  });

  it("renumbers bare numeric headings and separates a moved final section", () => {
    const numbered = "# 1\n\nas1\n\n# 2\n\nasd2\n\n# 3\n\nas3";
    const changed = moveSectionTo(numbered, lineOf(numbered, "# 3"), lineOf(numbered, "# 2"), "before")!;
    expect(parse(changed.text).map((heading) => heading.text)).toEqual(["1", "2", "3"]);
    expect(changed.text).toContain("# 2\n\nas3\n\n# 3\n\nasd2");
    expect(changed.text).not.toContain("as3#");
  });

  it("adds a same-level section after the complete selected section", () => {
    const changed = insertSiblingSection(note, lineOf(note, "## Alpha"))!;
    expect(changed.text.indexOf("### Alpha child")).toBeLessThan(changed.text.indexOf("## New section"));
    expect(changed.text.indexOf("## New section")).toBeLessThan(changed.text.indexOf("## Beta"));
    expect(changed.text.slice(changed.select!.anchor, changed.select!.head)).toBe("New section");
  });
});
