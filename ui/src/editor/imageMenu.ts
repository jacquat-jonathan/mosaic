import type { EditorView } from "@codemirror/view";
import { copyText } from "../actions";
import { errorMessage } from "../ipc/types";
import { useUi, type MenuItem } from "../state/ui";
import { useVault } from "../state/vault";
import type { EditorContext } from "./context";

export interface ImageSource {
  from: number;
  to: number;
  text: string;
}

/** Decode local bytes through a blob URL so drawing an asset-origin image never taints the canvas. */
async function imagePng(url: Promise<string>): Promise<Blob> {
  const response = await fetch(await url);
  if (!response.ok) throw new Error(`Image could not be read (${response.status})`);
  const blob = await response.blob();
  if (blob.type === "image/png") return blob;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) throw new Error("Image could not be decoded");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (png) => (png ? resolve(png) : reject(new Error("Image could not be converted to PNG"))),
        "image/png",
      ),
    );
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function imageMenu(
  wrap: HTMLElement,
  view: EditorView,
  ctx: EditorContext,
  path: string | null,
  source?: ImageSource,
  resetSize?: () => void,
) {
  const root = useVault.getState().vault?.root;
  const current = () => view.dom.isConnected && useVault.getState().vault?.root === root;
  const validSource = () =>
    current() &&
    source &&
    source.to <= view.state.doc.length &&
    view.state.doc.sliceString(source.from, source.to) === source.text;
  const open = () => {
    if (path && current()) {
      if (ctx.openFile) ctx.openFile(path);
      else ctx.openLink(path, true);
    }
  };
  const show = (x: number, y: number) => {
    if (!current()) return;
    const items: MenuItem[] = [];
    if (path) {
      items.push(
        { label: "Open image", action: open },
        {
          label: "Copy image",
          disabled: typeof ClipboardItem === "undefined" || !navigator.clipboard?.write,
          action: () => {
            if (!current()) return;
            try {
              // Invoke write during the user gesture; WebKit accepts the asynchronously produced PNG.
              const png = imagePng(ctx.fileUrl(path));
              void png.catch(() => {});
              void navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).catch((cause) => {
                if (current()) useVault.getState().setError(`Couldn't copy image: ${errorMessage(cause)}`);
              });
            } catch (cause) {
              if (current()) useVault.getState().setError(`Couldn't copy image: ${errorMessage(cause)}`);
            }
          },
        },
        { label: "Copy image path", action: () => current() && void copyText(path) },
      );
    }
    if (source) {
      items.push({ label: "Copy image reference", action: () => current() && void copyText(source.text) });
      if (items.length) items.push({ label: "", separator: true });
      items.push({
        label: "Edit image source",
        disabled: !validSource() || view.state.readOnly,
        action: () => {
          if (!validSource() || view.state.readOnly) return;
          view.dispatch({ selection: { anchor: source.from, head: source.to }, scrollIntoView: true });
          view.focus();
        },
      });
    }
    if (resetSize) items.push({ label: "Reset image size", action: () => current() && resetSize() });
    if (items.length) useUi.getState().showMenu(x, y, items);
  };
  // Keep the editor's caret out of the source range when clicking a rendered image.
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Image actions");
  wrap.title = "Right-click for image actions · Enter to open";
  wrap.addEventListener("mousedown", (event) => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    wrap.focus({ preventScroll: true });
  });
  wrap.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    show(event.clientX, event.clientY);
  });
  wrap.addEventListener("keydown", (event) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      event.stopPropagation();
      const box = wrap.getBoundingClientRect();
      show(box.left, box.bottom);
    } else if (event.target === wrap && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      open();
    }
  });
}
