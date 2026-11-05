import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { fileUrl } from "../ipc/api";
import { Button, Notice } from "../design-system/components";
import { DesignSystemScope } from "../views/DesignSystemScope";
import { useVault } from "../state/vault";
import "./documentStates.css";
import { errorMessage } from "../ipc/types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Renders every page to a canvas, lazily as pages scroll into view. */
export function PdfViewer({ path, maxPages, compact }: { path: string; maxPages?: number; compact?: boolean }) {
  const root = useVault((s) => s.vault?.root);
  const [retry, setRetry] = useState(0);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDoc(null);
    setError(null);
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    (async () => {
      try {
        const url = await fileUrl(path);
        if (!live || useVault.getState().vault?.root !== root) return;
        const data = url.startsWith("data:")
          ? Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0))
          : undefined;
        task = pdfjs.getDocument(data ? { data } : { url });
        const loaded = await task.promise;
        if (live) setDoc(loaded);
      } catch (e) {
        if (live) setError(errorMessage(e));
      }
    })();
    return () => {
      live = false;
      void task?.destroy();
    };
  }, [path, root, retry]);

  if (error)
    return (
      <DesignSystemScope className="document-state">
        <Notice tone="error">Couldn't open this PDF: {error}</Notice>
        <div>
          <Button variant="secondary" onClick={() => setRetry((n) => n + 1)}>
            Retry PDF
          </Button>
        </div>
      </DesignSystemScope>
    );
  if (!doc)
    return (
      <DesignSystemScope className="document-state">
        <Notice>Loading PDF…</Notice>
      </DesignSystemScope>
    );
  const count = Math.min(doc.numPages, maxPages ?? doc.numPages);
  return (
    <div
      className={compact ? "pdf-viewer compact" : "pdf-viewer"}
      role="region"
      aria-label={`PDF preview: ${path}`}
      tabIndex={0}
    >
      {!compact && (
        <DesignSystemScope className="pdf-details" role="group" aria-label="PDF details">
          {doc.numPages} page{doc.numPages === 1 ? "" : "s"}
        </DesignSystemScope>
      )}
      {Array.from({ length: count }, (_, i) => (
        <PdfPage key={i} doc={doc} number={i + 1} />
      ))}
      {count < doc.numPages && (
        <DesignSystemScope className="pdf-details">… {doc.numPages - count} more pages</DesignSystemScope>
      )}
    </div>
  );
}

function PdfPage({ doc, number }: { doc: pdfjs.PDFDocumentProxy; number: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState(false);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [visible, setVisible] = useState(number <= 2);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = holder.current;
    if (!el || visible) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVisible(true), {
      rootMargin: "600px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || width < 1) return;
    setError(null);
    setRendered(false);
    let task: pdfjs.RenderTask | null = null;
    let live = true;
    void doc
      .getPage(number)
      .then((page) => {
        const c = canvas.current;
        const el = holder.current;
        if (!live || !c || !el) return;
        const base = page.getViewport({ scale: 1 });
        const cssWidth = Math.min(width, 900);
        const scale = (cssWidth / base.width) * (window.devicePixelRatio || 1);
        const viewport = page.getViewport({ scale });
        c.width = viewport.width;
        c.height = viewport.height;
        c.style.width = `${cssWidth}px`;
        c.style.height = `${(cssWidth / base.width) * base.height}px`;
        task = page.render({ canvas: c, canvasContext: c.getContext("2d")!, viewport });
        task.promise.then(
          () => {
            if (live) setRendered(true);
          },
          (cause) => {
            if (live) setError(errorMessage(cause));
          },
        );
      })
      .catch((cause) => {
        if (live) setError(errorMessage(cause));
      });
    return () => {
      live = false;
      task?.cancel();
    };
  }, [doc, number, visible, width, retry]);

  return (
    <div
      ref={holder}
      className="pdf-page"
      aria-busy={(visible && !rendered && !error) || undefined}
      style={visible ? undefined : { minHeight: 600 }}
    >
      {error && (
        <DesignSystemScope className="document-state">
          <Notice tone="error">
            Page {number}: {error}
          </Notice>
          <Button onClick={() => setRetry((n) => n + 1)}>Retry page {number}</Button>
        </DesignSystemScope>
      )}
      <canvas ref={canvas} hidden={!!error} role="img" aria-label={`Page ${number}`} />
    </div>
  );
}
