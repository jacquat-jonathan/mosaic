// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, expect, test, vi } from "vitest";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { addWebLink } from "./selectionToolbar";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function editor() {
  const dom = document.createElement("div");
  document.body.append(dom);
  useVault.setState({ vault: { root: "/first", name: "First" } });
  return {
    dom,
    state: EditorState.create({ doc: "Chosen", selection: { anchor: 0, head: 6 } }),
    dispatch: vi.fn(),
    focus: vi.fn(),
  };
}
test("link prompts restore focus on cancellation and apply to the connected selection", async () => {
  const view = editor();
  vi.spyOn(useUi.getState(), "askText").mockResolvedValueOnce(null).mockResolvedValueOnce("https://example.com");
  expect(addWebLink(view as unknown as EditorView)).toBe(true);
  await Promise.resolve();
  expect(view.focus).toHaveBeenCalledOnce();
  expect(view.dispatch).not.toHaveBeenCalled();
  addWebLink(view as unknown as EditorView);
  await Promise.resolve();
  expect(view.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ changes: { from: 0, to: 6, insert: "[Chosen](https://example.com)" } }),
  );
});
test.each(["closed editor", "different vault"])("a late link choice cannot edit a %s", async (condition) => {
  let resolve!: (value: string | null) => void;
  const pending = new Promise<string | null>((done) => {
    resolve = done;
  });
  vi.spyOn(useUi.getState(), "askText").mockReturnValue(pending);
  const view = editor();
  addWebLink(view as unknown as EditorView);
  if (condition === "closed editor") view.dom.remove();
  else useVault.setState({ vault: { root: "/second", name: "Second" } });
  resolve("https://example.com");
  await pending;
  expect(view.dispatch).not.toHaveBeenCalled();
  expect(view.focus).not.toHaveBeenCalled();
});
