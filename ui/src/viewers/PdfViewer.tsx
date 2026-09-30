import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { fileUrl } from "../ipc/api";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Renders every page to a canvas, lazily as pages scroll into view. */
export function PdfViewer({ path, maxPages, compact }: { path: string; maxPages?: number; compact?: boolean }) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    (async () => {
      try {
        const url = await fileUrl(path);
        const data = url.startsWith("data:") ? Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0)) : undefined;
        task = pdfjs.getDocument(data ? { data } : { url });
        const loaded = await task.promise;
        if (live) setDoc(loaded);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
      void task?.destroy();
    };
  }, [path]);

  if (error) return <div className="empty"><p>Couldn't open this PDF: {error}</p></div>;
  if (!doc) return <div className="empty"><p>Loading PDF…</p></div>;
  const count = Math.min(doc.numPages, maxPages ?? doc.numPages);
  return (
    <div className={compact ? "pdf-viewer compact" : "pdf-viewer"}>
      {!compact && <div className="pdf-meta">{doc.numPages} page{doc.numPages === 1 ? "" : "s"}</div>}
      {Array.from({ length: count }, (_, i) => (
        <PdfPage key={i} doc={doc} number={i + 1} />
      ))}
      {count < doc.numPages && <div className="pdf-meta">… {doc.numPages - count} more pages</div>}
    </div>
  );
}

function PdfPage({ doc, number }: { doc: pdfjs.PDFDocumentProxy; number: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(number <= 2);

  useEffect(() => {
    const el = holder.current;
    if (!el || visible) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let task: pdfjs.RenderTask | null = null;
    let live = true;
    void doc.getPage(number).then((page) => {
      const c = canvas.current;
      const el = holder.current;
      if (!live || !c || !el) return;
      const base = page.getViewport({ scale: 1 });
      const cssWidth = Math.min(el.clientWidth || 800, 900);
      const scale = (cssWidth / base.width) * (window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale });
      c.width = viewport.width;
      c.height = viewport.height;
      c.style.width = `${cssWidth}px`;
      c.style.height = `${(cssWidth / base.width) * base.height}px`;
      task = page.render({ canvas: c, canvasContext: c.getContext("2d")!, viewport });
      task.promise.catch(() => {});
    });
    return () => {
      live = false;
      task?.cancel();
    };
  }, [doc, number, visible]);

  return (
    <div ref={holder} className="pdf-page" style={visible ? undefined : { minHeight: 600 }}>
      <canvas ref={canvas} />
    </div>
  );
}
