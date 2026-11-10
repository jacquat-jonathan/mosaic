// Imported only by the explicitly enabled native smoke build. Failure reports contain
// fixture UI state, never screenshots of another application or an entire page dump.
export function collectViewerDiagnostics() {
  return {
    notices: Array.from(document.querySelectorAll(".document-state"), (node) =>
      (node.textContent ?? "").slice(0, 2000),
    ).slice(0, 10),
    pages: Array.from(document.querySelectorAll<HTMLElement>(".pdf-page"), (page) => {
      const canvas = page.querySelector("canvas");
      return {
        busy: page.getAttribute("aria-busy"),
        width: page.clientWidth,
        height: page.clientHeight,
        canvas: canvas ? { width: canvas.width, height: canvas.height, hidden: canvas.hidden } : null,
      };
    }).slice(0, 10),
    visibility: document.visibilityState,
    features: {
      promiseWithResolvers: typeof Promise.withResolvers,
      uint8ToHex: typeof (Uint8Array.prototype as unknown as { toHex?: unknown }).toHex,
      arrayBufferTransfer: typeof ArrayBuffer.prototype.transferToFixedLength,
    },
  };
}
