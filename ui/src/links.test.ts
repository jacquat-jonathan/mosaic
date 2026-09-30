import { expect, test } from "vitest";
import { linkLabel, linkTextFor, parseWikiLink, resolveLink } from "./links";
import type { Entry } from "./ipc/types";

const files = (...paths: string[]): Entry[] =>
  paths.map((path) => ({ path, name: path.split("/").pop()!, is_dir: false, kind: null, size: 0, mtime: 0 }));

const vault = files("Home.md", "Ideas.md", "Projects/Mosaic/Plan.md", "Archive/Plan.md", "Attachments/diagram.png", "Daily/2026-09-30.md");

test("parses target, heading, block and alias", () => {
  expect(parseWikiLink("Note#Heading|Shown")).toEqual({ target: "Note", heading: "Heading", block: null, alias: "Shown" });
  expect(parseWikiLink("Note^abc")).toEqual({ target: "Note", heading: null, block: "abc", alias: null });
  expect(linkLabel(parseWikiLink("a/b/Note#H"))).toBe("Note › H");
});

test("resolves case-insensitively, with or without .md", () => {
  expect(resolveLink("home", vault, null)).toBe("Home.md");
  expect(resolveLink("Ideas.md", vault, null)).toBe("Ideas.md");
  expect(resolveLink("diagram.png", vault, null)).toBe("Attachments/diagram.png");
  expect(resolveLink("2026-09-30", vault, null)).toBe("Daily/2026-09-30.md");
  expect(resolveLink("Nope", vault, null)).toBeNull();
});

test("ambiguous names prefer the exact path, then the same folder, then the shortest path", () => {
  expect(resolveLink("Archive/Plan", vault, null)).toBe("Archive/Plan.md");
  expect(resolveLink("Plan", vault, "Projects/Mosaic/Other.md")).toBe("Projects/Mosaic/Plan.md");
  expect(resolveLink("Plan", vault, "Home.md")).toBe("Archive/Plan.md");
});

test("relative markdown links resolve against the source folder", () => {
  expect(resolveLink("../../Ideas.md", vault, "Projects/Mosaic/Plan.md")).toBe("Ideas.md");
});

test("link text is the shortest unique form", () => {
  expect(linkTextFor("Ideas.md", vault)).toBe("Ideas");
  expect(linkTextFor("Projects/Mosaic/Plan.md", vault)).toBe("Projects/Mosaic/Plan");
  expect(linkTextFor("Attachments/diagram.png", vault)).toBe("diagram.png");
});
