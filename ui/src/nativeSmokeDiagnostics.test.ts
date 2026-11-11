// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { collectViewerDiagnostics } from "./nativeSmokeDiagnostics";

afterEach(() => {
  document.body.replaceChildren();
});

test("native failure evidence distinguishes PDF load errors from pending or failed page renders", () => {
  document.body.innerHTML = `<div class="document-state">Couldn't open this PDF: worker failed</div>
    <div class="pdf-page" aria-busy="true"><canvas width="120" height="240"></canvas></div>
    <div class="pdf-page"><div class="document-state">Page 2: rendering failed</div><canvas hidden></canvas></div>`;
  const report = collectViewerDiagnostics();
  expect(report.notices).toEqual(["Couldn't open this PDF: worker failed", "Page 2: rendering failed"]);
  expect(report.pages[0]).toMatchObject({ busy: "true", canvas: { width: 120, height: 240, hidden: false } });
  expect(report.pages[1]).toMatchObject({ busy: null, canvas: { hidden: true } });
  expect(JSON.parse(JSON.stringify(report))).toEqual(report);
});

test("native diagnostics bound fixture text and ignore unrelated document text", () => {
  document.body.innerHTML = `<main>unrelated content</main><div class="document-state">${"x".repeat(3000)}</div>`;
  const report = collectViewerDiagnostics();
  expect(report.notices).toEqual(["x".repeat(2000)]);
  expect(report.pages).toEqual([]);
});
