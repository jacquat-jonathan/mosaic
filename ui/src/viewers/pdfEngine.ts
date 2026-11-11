// WKWebView follows the installed macOS version, not the app. Use matching legacy builds so
// PDF.js supplies its own compatibility support (for example Map.getOrInsertComputed).
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export { pdfjs };
