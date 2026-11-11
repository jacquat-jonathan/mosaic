// @vitest-environment node
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

function blankPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = text.length;
  text += "xref\n0 5\n0000000000 65535 f \n";
  text += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  text += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

test("the viewer's PDF engine and bundled worker render without newer WebKit APIs", async () => {
  // Safari 18 lacks getOrInsertComputed. Also exercise the legacy build's typed-array
  // compatibility for the older WebKit versions supported by the production build target.
  const targets = [
    [Map.prototype, "getOrInsertComputed"],
    [Uint8Array.prototype, "toHex"],
  ] as const;
  const descriptors = targets.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key));
  for (const [target, key] of targets) Reflect.deleteProperty(target, key);
  let task: { destroy(): Promise<void> } | undefined;
  try {
    const { pdfjs } = await import("./pdfEngine");
    // Node uses PDF.js's fake worker in this realm. Check the main engine before
    // loading it, so worker polyfills cannot mask a modern-main/legacy-worker mismatch.
    expect(typeof Reflect.get(Map.prototype, "getOrInsertComputed")).toBe("function");
    expect(typeof Reflect.get(Uint8Array.prototype, "toHex")).toBe("function");
    // Vite's asset URL points at the exact worker selected by the viewer. Resolve that
    // asset on disk for PDF.js's Node worker, rather than substituting a test worker.
    const url = pdfjs.GlobalWorkerOptions.workerSrc;
    const worker = url.startsWith("/@fs/") ? url.slice(4) : path.resolve(process.cwd(), `.${url}`);
    expect(existsSync(worker), `bundled worker asset ${url}`).toBe(true);
    pdfjs.GlobalWorkerOptions.workerSrc = worker;
    const loading = pdfjs.getDocument({ data: blankPdf() });
    task = loading;
    const document = await loading.promise;
    expect(document.numPages).toBe(1);
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    type Canvas = { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };
    const factory = document.canvasFactory as {
      create(width: number, height: number): Canvas;
      destroy(canvas: Canvas): void;
    };
    const canvas = factory.create(viewport.width, viewport.height);
    try {
      await page.render({ canvas: canvas.canvas, canvasContext: canvas.context, viewport }).promise;
      expect([canvas.canvas.width, canvas.canvas.height]).toEqual([100, 100]);
      expect(Array.from(canvas.context.getImageData(50, 50, 1, 1).data)).toEqual([255, 255, 255, 255]);
    } finally {
      factory.destroy(canvas);
    }
  } finally {
    await task?.destroy();
    for (const [index, [target, key]] of targets.entries()) {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  }
});
