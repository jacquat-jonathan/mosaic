import { expect, test } from "vitest";
import { linkLabel, linkTextFor, parseWikiLink, resolveLink } from "./links";
import { isTextKind, kindOf } from "./ipc/kinds";
import type { Entry } from "./ipc/types";
import shared from "../../fixtures/links.json";

const files = (...paths: string[]): Entry[] =>
  paths.map((path) => ({ path, name: path.split("/").pop()!, is_dir: false, kind: null, size: 0, mtime: 0 }));

// Cases shared with crates/mosaic-core/src/links.rs.
const vault = files(...shared.files);
const aliases = shared.aliases as [string, string][];

test("parses target, heading, block and alias", () => {
  expect(parseWikiLink("Note#Heading|Shown")).toEqual({
    target: "Note",
    heading: "Heading",
    block: null,
    alias: "Shown",
  });
  expect(parseWikiLink("Note^abc")).toEqual({ target: "Note", heading: null, block: "abc", alias: null });
  expect(linkLabel(parseWikiLink("a/b/Note#H"))).toBe("Note › H");
});

test.each(shared.resolve.map((c) => [c.why, c] as const))("resolves: %s", (_why, c) => {
  expect(resolveLink(c.target, vault, c.from, aliases, "markdown" in c ? c.markdown : false)).toBe(c.expected);
});

test.each(shared.linkText.map((c) => [c.why, c] as const))("link text: %s", (_why, c) => {
  expect(linkTextFor(c.path, vault, c.from)).toBe(c.expected);
});

test("covers empty fragments, root traversal, aliases and deterministic ties", () => {
  expect(parseWikiLink("Note|")).toEqual({ target: "Note", heading: null, block: null, alias: null });
  expect(parseWikiLink("Note^")).toEqual({ target: "Note", heading: null, block: null, alias: null });
  expect(parseWikiLink("Note#")).toEqual({ target: "Note", heading: null, block: null, alias: null });
  expect(linkLabel(parseWikiLink("Folder/Note^block"))).toBe("Note › ^block");
  expect(linkLabel(parseWikiLink("|Alias"))).toBe("Alias");
  expect(linkLabel(parseWikiLink("#Heading"))).toBe(" › Heading");

  const tied = files("Z/Note.md", "a/Note.md", "Root.md");
  expect(resolveLink("Note", tied, "Elsewhere/From.md")).toBe("Z/Note.md");
  expect(resolveLink("Note", files("a/Note.md", "Z/Note.md"), "Elsewhere/From.md")).toBe("Z/Note.md");
  expect(resolveLink("", tied, "Root.md")).toBe("Root.md");
  expect(resolveLink("", tied, null)).toBeNull();
  expect(resolveLink("../../outside", tied, "From.md", [], true)).toBeNull();
  expect(resolveLink("/Root", tied, null)).toBe("Root.md");
  expect(resolveLink("./Root", tied, null, [], true)).toBe("Root.md");
  expect(resolveLink("nickname", tied, null, [["NickName", "Root.md"]])).toBe("Root.md");
  expect(linkTextFor("Root.md", tied)).toBe("Root");
});

test("file kinds cover extensionless and unknown paths", () => {
  expect(kindOf("README")).toBe("other");
  expect(kindOf("archive.unlisted")).toBe("other");
  expect(kindOf("chart.vl.json")).toBe("json");
  expect(isTextKind("other")).toBe(false);
  expect(isTextKind("markdown")).toBe(true);
});
