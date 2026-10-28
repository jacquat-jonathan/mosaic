// @vitest-environment jsdom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, test, vi } from "vitest";
import { editorContext, type EditorContext } from "./context";
import { livePreview, refreshPreview, selectionTouches } from "./livePreview";

function state(anchor: number, head = anchor) {
  return EditorState.create({ doc: "abcd", selection: { anchor, head } });
}

test("a caret belongs to the span that starts at its position, not the one that ends there", () => {
  expect(selectionTouches(state(2), 0, 2)).toBe(false);
  expect(selectionTouches(state(2), 2, 4)).toBe(true);
  expect(selectionTouches(state(4), 2, 4)).toBe(false);
});

test("a non-empty selection touches every span it intersects", () => {
  expect(selectionTouches(state(1, 3), 0, 2)).toBe(true);
  expect(selectionTouches(state(1, 3), 2, 4)).toBe(true);
  expect(selectionTouches(state(2, 4), 0, 2)).toBe(false);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

test("live preview decorates rich Markdown and reveals syntax around the selection", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const context: EditorContext = {
    path: "Notes/Rich.md",
    resolve: vi.fn((target) => {
      if (target === "Missing") return null;
      if (/\.(png|pdf|canvas)$/i.test(target)) return `Assets/${target}`;
      return `Notes/${target}.md`;
    }),
    openLink: vi.fn(),
    openExternal: vi.fn(),
    openTag: vi.fn(),
    fileUrl: vi.fn(async (path) => `blob:${path}`),
    readText: vi.fn(async (path) => (path.endsWith(".canvas") ? '{"nodes":[],"edges":[]}' : "# Embedded note")),
    importDrop: vi.fn(() => null),
    linkCandidates: vi.fn(() => []),
  };
  const doc = `---
title: Rich
---
# Heading
## Heading two
Paragraph with *emphasis*, **strong**, ~~strike~~, \`code\`, ==highlight==, $x+1$, #tag/nested and <https://example.test>.

[Internal](Target.md) and [External](https://example.test/page) and ![remote](https://example.test/image.png).
![local|240](photo.png)
[[Target|Alias]] [[Missing]] ![[photo.png|300]] ![[paper.pdf]] ![[diagram.canvas]] ![[Note]].

> Quote

---
- bullet
- [ ] open task
- [x] done task
1. ordered

<!-- mosaic:state=in-progress -->

| A | B |
| --- | --- |
| one | two |

$$
x^2
$$

\`\`\`text
plain code
\`\`\`

<div>html block</div>
`;
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [editorContext.of(context), markdown({ base: markdownLanguage }), livePreview()],
    }),
  });

  expect(parent.querySelector(".cm-h1")).toBeTruthy();
  expect(parent.querySelector(".cm-em")).toBeTruthy();
  expect(parent.querySelector(".cm-strong")).toBeTruthy();
  expect(parent.querySelector(".cm-strike")).toBeTruthy();
  expect(parent.querySelector(".cm-highlight")).toBeTruthy();
  expect(parent.querySelector(".cm-tag")?.getAttribute("data-tag")).toBe("tag/nested");
  expect(parent.querySelector(".cm-math")).toBeTruthy();
  expect(parent.querySelector(".cm-task")).toBeTruthy();
  expect(parent.querySelector(".cm-table-wrap")).toBeTruthy();
  expect(parent.querySelector(".cm-wikilink")).toBeTruthy();
  expect(parent.querySelector(".cm-embed-image, .cm-embed-note, .cm-embed-canvas")).toBeTruthy();

  const renderedWiki = parent.querySelector<HTMLElement>(".cm-wikilink");
  renderedWiki?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  expect(context.openLink).toHaveBeenCalled();
  const tag = parent.querySelector<HTMLElement>(".cm-tag");
  tag?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  expect(context.openTag).toHaveBeenCalledWith("tag/nested");

  const emphasis = doc.indexOf("*emphasis*") + 2;
  view.dispatch({ selection: { anchor: emphasis }, effects: refreshPreview.of(null) });
  expect(parent.textContent).toContain("*emphasis*");
  view.dispatch({ selection: { anchor: 2 } });
  expect(parent.textContent).toContain("title: Rich");
  view.dispatch({ selection: { anchor: doc.indexOf("plain code") } });
  expect(parent.textContent).toContain("plain code");
  window.dispatchEvent(new Event("mosaic-theme"));
  view.destroy();
});
