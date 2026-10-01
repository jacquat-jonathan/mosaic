import { expect, test } from "vitest";
import { linkLabel, linkTextFor, parseWikiLink, resolveLink } from "./links";
import type { Entry } from "./ipc/types";
import shared from "../../fixtures/links.json";

const files = (...paths: string[]): Entry[] =>
  paths.map((path) => ({ path, name: path.split("/").pop()!, is_dir: false, kind: null, size: 0, mtime: 0 }));

// Cases shared with crates/mosaic-core/src/links.rs.
const vault = files(...shared.files);
const aliases = shared.aliases as [string, string][];

test("parses target, heading, block and alias", () => {
  expect(parseWikiLink("Note#Heading|Shown")).toEqual({ target: "Note", heading: "Heading", block: null, alias: "Shown" });
  expect(parseWikiLink("Note^abc")).toEqual({ target: "Note", heading: null, block: "abc", alias: null });
  expect(linkLabel(parseWikiLink("a/b/Note#H"))).toBe("Note › H");
});

test.each(shared.resolve.map((c) => [c.why, c] as const))("resolves: %s", (_why, c) => {
  expect(resolveLink(c.target, vault, c.from, aliases, "markdown" in c ? c.markdown : false)).toBe(c.expected);
});

test.each(shared.linkText.map((c) => [c.why, c] as const))("link text: %s", (_why, c) => {
  expect(linkTextFor(c.path, vault, c.from)).toBe(c.expected);
});
