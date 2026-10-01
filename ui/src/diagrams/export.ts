// Export a canvas as an SVG or PNG file next to it (light theme, so it reads well in documents).
// The file never overwrites anything: a taken name gets " 1", " 2"…

import { api } from "../ipc/api";
import { useWorkspace } from "../state/workspace";
import { parentOf } from "../state/vault";
import type { CanvasDoc } from "../viewers/canvas/jsonCanvas";
import { canvasToSvg } from "./canvasToSvg";

/** Draws an SVG into a PNG at `scale` (2 = sharp on Retina screens). */
async function svgToPng(svg: string, scale = 2): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("The diagram couldn't be drawn as an image."));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(img.width * scale);
    canvas.height = Math.ceil(img.height * scale);
    const g = canvas.getContext("2d")!;
    g.scale(scale, scale);
    g.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The image couldn't be encoded as PNG.");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Writes `<canvas name>.svg` / `.png` next to the canvas and opens it. Resolves to the new path. */
export async function exportCanvas(canvasPath: string, doc: CanvasDoc, format: "svg" | "png"): Promise<string> {
  const svg = canvasToSvg(doc, false);
  const bytes = format === "svg" ? new TextEncoder().encode(svg) : await svgToPng(svg);
  const stem = canvasPath.split("/").pop()!.replace(/\.canvas$/i, "");
  const dir = parentOf(canvasPath);
  const written = await api.importFile(dir ? `${dir}/${stem}.${format}` : `${stem}.${format}`, bytes);
  await useWorkspace.getState().open(written.path, { newTab: true });
  return written.path;
}
