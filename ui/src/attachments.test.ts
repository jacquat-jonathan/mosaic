import { expect, test } from "vitest";
import type { Entry } from "./ipc/types";
import { isQuietAttachment, noteAttachments } from "./attachments";

const entry = (path: string, kind: Entry["kind"]): Entry => ({
  path,
  name: path.split("/").pop()!,
  is_dir: false,
  kind,
  size: 1,
  mtime: 0,
});
const entries = [
  entry("Notes/Plan.md", "markdown"),
  entry("Notes/photo one.png", "image"),
  entry("Assets/brief.pdf", "pdf"),
  entry("Map.canvas", "canvas"),
];

test("quiet tree assets are images and PDFs, not ordinary source files", () => {
  expect(isQuietAttachment(entries[1])).toBe(true);
  expect(isQuietAttachment(entries[2])).toBe(true);
  expect(isQuietAttachment(entry("Makefile", "other"))).toBe(false);
});

test("note attachments resolve wiki and Markdown embeds, omit notes and deduplicate", () => {
  const text = "![[photo one.png]]\n![brief](../Assets/brief.pdf)\n![[Map.canvas]]\n![[Plan]]\n![[photo one.png]]";
  expect(noteAttachments(text, "Notes/Plan.md", entries)).toEqual([
    "Notes/photo one.png",
    "Assets/brief.pdf",
    "Map.canvas",
  ]);
});

test("remote Markdown images are not vault attachments", () => {
  expect(noteAttachments("![remote](https://example.com/a.png)", "Notes/Plan.md", entries)).toEqual([]);
});
