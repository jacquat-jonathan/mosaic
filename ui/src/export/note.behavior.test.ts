// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Buffer } from "../state/workspace";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";

vi.mock("../editor/blocks", () => ({ renderBlocksAll: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../ipc/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc/api")>();
  return { ...actual, fileUrl: vi.fn() };
});

import { api, fileUrl } from "../ipc/api";
import { exportNoteHtml, noteToHtml, printNote } from "./note";

const main = `---
title: <Unsafe & useful>
tags: [one, two]
empty:
---
# Main
[[Target|Ordinary]]
![[Missing]]
![[Images/pic.png]]
![[Images/broken.png]]
![[Diagram.canvas]]
![[Embedded]]
![[File.pdf]]
![local](../Images/local-inline.png)
![remote](https://example.test/image.png)
`;

const buffer = (path: string, content: string): Buffer => ({
  path,
  kind: "markdown",
  content,
  baseHash: "hash",
  dirty: true,
  conflict: null,
  deleted: false,
  error: null,
  version: 1,
});

beforeEach(() => {
  document.body.replaceChildren();
  useVault.setState({
    vault: { root: "/vault", name: "Vault" },
    entries: [
      "Notes/Main.md",
      "Notes/Target.md",
      "Notes/Embedded.md",
      "Notes/Deep.md",
      "Images/pic.png",
      "Images/broken.png",
      "Images/local-inline.png",
      "Diagram.canvas",
      "File.pdf",
      "Notes/Remote.md",
    ].map((path) => ({ path, name: path.split("/").pop()!, is_dir: false, kind: null, size: 1, mtime: 1 })),
    setError: vi.fn(),
  });
  useWorkspace.setState({ buffers: { "Notes/Main.md": buffer("Notes/Main.md", main) } });
  vi.mocked(fileUrl).mockImplementation(async (path) => {
    if (path.includes("broken")) throw new Error("missing bytes");
    if (path.includes("local-inline")) return "blob:local-inline";
    return "data:image/png;base64,eA==";
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Blob(["pixels"], { type: "image/png" }))),
  );
  vi.spyOn(api, "read").mockImplementation(async (path) => ({
    path,
    kind: path.endsWith(".canvas") ? "canvas" : "markdown",
    size: 1,
    mtime: 1,
    hash: "hash",
    review: null,
    content: path.endsWith(".canvas")
      ? '{"nodes":[],"edges":[]}'
      : path.endsWith("Embedded.md")
        ? "---\ntitle: Nested\n---\n## Embedded\n![[Deep]]"
        : "# Loaded from disk",
  }));
  vi.spyOn(api, "importFile").mockResolvedValue({ path: "Notes/Main.html", hash: "written", review: null });
  vi.spyOn(api, "printWindow").mockResolvedValue(undefined);
  vi.spyOn(useWorkspace.getState(), "open").mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("standalone note export resolves every embed kind and image fallback", async () => {
  const html = await noteToHtml("Notes/Main.md");
  expect(html).toContain("&lt;Unsafe &amp; useful&gt;");
  expect(html).toContain('<span class="link">Ordinary</span>');
  expect(html).toContain("Missing (missing)");
  expect(html).toContain('<img src="data:image/png;base64,eA=="');
  expect(html).toContain('<span class="missing">Images/broken.png</span>');
  expect(html).toContain('class="embed-canvas"');
  expect(html).toContain('class="embed-note"');
  expect(html).toContain("Embedded");
  expect(html).toContain("Deep");
  expect(html).toContain("File.pdf");
  expect(html).toContain("https://example.test/image.png");
  expect(html).not.toContain("empty:</dt>");
  expect(fetch).toHaveBeenCalledWith("blob:local-inline");

  useWorkspace.setState({ buffers: {} });
  const loaded = await noteToHtml("Notes/Remote.md");
  expect(loaded).toContain("Loaded from disk");
  expect(api.read).toHaveBeenCalledWith("Notes/Remote.md");
});

test("HTML export writes beside the note and opens the result", async () => {
  const path = await exportNoteHtml("Notes/Main.md");
  expect(path).toBe("Notes/Main.html");
  expect(vi.mocked(api.importFile).mock.calls[0][0]).toBe("Notes/Main.html");
  expect(ArrayBuffer.isView(vi.mocked(api.importFile).mock.calls[0][1])).toBe(true);
  expect(useWorkspace.getState().open).toHaveBeenCalledWith("Notes/Main.html", { newTab: true });

  useWorkspace.setState({ buffers: { "Root.md": buffer("Root.md", "Root") } });
  vi.mocked(api.importFile).mockResolvedValueOnce({ path: "Root.html", hash: "root", review: null });
  expect(await exportNoteHtml("Root.md")).toBe("Root.html");
  expect(vi.mocked(api.importFile).mock.calls.at(-1)?.[0]).toBe("Root.html");
});

test("print preview handles print errors, close and Escape", async () => {
  vi.mocked(api.printWindow).mockRejectedValueOnce(new Error("printer unavailable"));
  await printNote("Notes/Main.md");
  const first = document.querySelector<HTMLElement>(".print-root")!;
  first.querySelector<HTMLButtonElement>('[data-act="print"]')!.click();
  await vi.waitFor(() => expect(useVault.getState().setError).toHaveBeenCalledWith("printer unavailable"));
  first.querySelector<HTMLButtonElement>('[data-act="close"]')!.click();
  expect(document.querySelector(".print-root")).toBeNull();

  await printNote("Notes/Main.md");
  await printNote("Notes/Main.md");
  expect(document.querySelectorAll(".print-root")).toHaveLength(1);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector(".print-root")).toBeNull();
});
