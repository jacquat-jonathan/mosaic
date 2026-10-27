// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  clampHtmlZoom,
  embedLocalFetches,
  htmlScriptPermission,
  htmlPreviewCsp,
  isLocalHtmlResource,
  renderHtmlMermaid,
  resolveHtmlResource,
} from "./HtmlViewer";

describe("HTML preview resources", () => {
  it("keeps preview zoom on stable ten-percent steps and within usable limits", () => {
    expect(clampHtmlZoom(0.1)).toBe(0.5);
    expect(clampHtmlZoom(0.799999999)).toBe(0.8);
    expect(clampHtmlZoom(1.100000001)).toBe(1.1);
    expect(clampHtmlZoom(4)).toBe(2);
  });

  it("resolves sibling and parent vault resources without escaping the vault root", () => {
    expect(resolveHtmlResource("Reports/site", "./styles/page.css?v=2")).toBe("Reports/site/styles/page.css");
    expect(resolveHtmlResource("Reports/site", "../data.json#chart")).toBe("Reports/data.json");
    expect(resolveHtmlResource("Reports/site", "../../../../image.png")).toBe("image.png");
  });

  it("distinguishes relative vault resources from external and document-only links", () => {
    expect(isLocalHtmlResource("data/chart.json")).toBe(true);
    for (const value of ["https://example.com/a.css", "//example.com/a.css", "data:text/plain,x", "#section"]) {
      expect(isLocalHtmlResource(value)).toBe(false);
    }
  });

  it("allows vault assets and relative data fetches while keeping network schemes blocked", () => {
    const blocked = htmlPreviewCsp(false);
    expect(blocked).toContain("connect-src data: asset: http://asset.localhost");
    expect(blocked).toContain("script-src 'none'");
    expect(blocked).not.toContain("https:");
    const allowed = htmlPreviewCsp(true);
    expect(allowed).toContain("script-src data: asset: http://asset.localhost");
    expect(allowed).not.toContain("https:");
  });

  it("uses the vault script policy by default and lets each page override it", () => {
    expect(htmlScriptPermission(false)).toEqual({
      allowed: false,
      source: "vault",
      label: "Scripts blocked by vault setting",
    });
    expect(htmlScriptPermission(true, false)).toEqual({
      allowed: false,
      source: "page",
      label: "Scripts blocked for this page",
    });
    expect(htmlScriptPermission(false, true).allowed).toBe(true);
  });

  it("embeds literal local fetches but leaves external and dynamic requests alone", async () => {
    const loaded: string[] = [];
    const source = `const a=fetch('./flows.json'); const b=fetch("https://example.com/x"); fetch(variable);`;
    const out = await embedLocalFetches(source, "Test html", async (path) => {
      loaded.push(path);
      return '{"label":"it\'s ready"}';
    });
    expect(loaded).toEqual(["Test html/flows.json"]);
    expect(out).toContain("fetch('data:application/json;charset=utf-8,%7B%22label%22%3A%22it%27s%20ready%22%7D')");
    expect(out).toContain('fetch("https://example.com/x")');
    expect(out).toContain("fetch(variable)");
  });

  it("renders common Mermaid containers with sanitized bundled output", async () => {
    const doc = new DOMParser().parseFromString(
      '<main><div class="mermaid">flowchart LR\nA--&gt;B</div>' +
        '<pre><code class="language-mermaid">sequenceDiagram\nA-&gt;&gt;B: Hi</code></pre>' +
        '<pre><code class="language-js">alert(1)</code></pre></main>',
      "text/html",
    );
    const sources: string[] = [];
    await renderHtmlMermaid(doc, async (source) => {
      sources.push(source);
      return '<svg onload="alert(1)"><script>alert(2)</script><text>Rendered</text></svg>';
    });
    expect(sources).toEqual(["flowchart LR\nA-->B", "sequenceDiagram\nA->>B: Hi"]);
    expect(doc.querySelectorAll(".mosaic-mermaid")).toHaveLength(2);
    expect(doc.querySelector(".mermaid, code.language-mermaid")).toBeNull();
    expect(doc.querySelector("code.language-js")?.textContent).toBe("alert(1)");
    expect(doc.body.innerHTML).not.toMatch(/onload|<script/i);
    expect(doc.body.textContent).toContain("Rendered");
  });
});
