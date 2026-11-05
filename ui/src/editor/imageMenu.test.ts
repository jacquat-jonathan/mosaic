// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, expect, test, vi } from "vitest";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import type { EditorContext } from "./context";
import { imageMenu } from "./imageMenu";

const source = { from: 0, to: 10, text: "![[a.png]]" };
function setup(readOnly = false, path: string | null = null) {
  const wrap = document.createElement("span");
  document.body.append(wrap);
  const view = {
    dom: wrap,
    state: EditorState.create({ doc: source.text, extensions: EditorState.readOnly.of(readOnly) }),
    dispatch: vi.fn(),
    focus: vi.fn(),
  } as unknown as EditorView;
  const ctx = { openFile: vi.fn(), fileUrl: vi.fn(async () => "blob:local-image") } as unknown as EditorContext;
  imageMenu(wrap, view, ctx, path, source);
  return { wrap, view, ctx };
}
const show = (wrap: HTMLElement) => wrap.dispatchEvent(new MouseEvent("contextmenu", { cancelable: true }));
const item = (label: string) => useUi.getState().menu!.items.find((entry) => entry.label === label)!;

afterEach(() => {
  document.body.replaceChildren();
  useUi.getState().hideMenu();
  vi.unstubAllGlobals();
});

test("missing images keep source actions, readonly images refuse edits, and stale menus cannot edit", () => {
  const { wrap, view } = setup();
  const click = new MouseEvent("mousedown", { cancelable: true });
  wrap.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(view.dispatch).not.toHaveBeenCalled();
  show(wrap);
  expect(item("Copy image")).toBeUndefined();
  const edit = item("Edit image source");
  expect(edit.disabled).toBe(false);
  edit.action!();
  expect(view.dispatch).toHaveBeenCalledWith({ selection: { anchor: 0, head: 10 }, scrollIntoView: true });
  vi.mocked(view.dispatch).mockClear();
  wrap.remove();
  edit.action!();
  expect(view.dispatch).not.toHaveBeenCalled();
  const readonly = setup(true);
  show(readonly.wrap);
  expect(item("Edit image source").disabled).toBe(true);
  item("Edit image source").action!();
  expect(readonly.view.dispatch).not.toHaveBeenCalled();
});

test("image copying starts the clipboard write during the gesture and reports failures", async () => {
  let finish!: (url: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const write = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { write } });
  vi.stubGlobal(
    "ClipboardItem",
    class {
      constructor(readonly data: Record<string, Promise<Blob>>) {}
    },
  );
  const fetchImage = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) }));
  vi.stubGlobal("fetch", fetchImage);
  const { wrap, ctx } = setup(false, "a.png");
  vi.mocked(ctx.fileUrl).mockReturnValue(pending);
  show(wrap);
  item("Copy image").action!();
  expect(write).toHaveBeenCalledTimes(1);
  expect(fetchImage).not.toHaveBeenCalled();
  finish("blob:local-image");
  await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledWith("blob:local-image"));
  const png = (write.mock.calls[0] as unknown as [[{ data: Record<string, Promise<Blob>> }]])[0][0].data["image/png"];
  expect((await png).type).toBe("image/png");
  write.mockRejectedValueOnce(new Error("Clipboard denied"));
  show(wrap);
  item("Copy image").action!();
  await vi.waitFor(() => expect(useVault.getState().error).toContain("Couldn't copy image: Clipboard denied"));
});
