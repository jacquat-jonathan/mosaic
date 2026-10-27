import DOMPurify from "dompurify";

/**
 * Cleans SVG markup from a renderer (Graphviz, canvases) before it is put into the page. Renderers
 * copy attributes from the diagram source (DOT `URL`/`href`, labels…) into the SVG, so scripts,
 * event handlers and `javascript:` links are removed here instead of relying on the CSP alone.
 * Mermaid is sanitized separately with an HTML+SVG profile so its `foreignObject` labels survive.
 */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
}

/** Cleans Mermaid's SVG while retaining the HTML labels it emits inside `foreignObject`. Mermaid
 * also renders with `securityLevel: "strict"`; this second boundary protects the HTML preview from
 * renderer regressions without requiring arbitrary page scripts. */
export function sanitizeMermaidSvg(svg: string): string {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName === "parsererror") return "";
  const labels = [...root.querySelectorAll("foreignObject")].map((foreignObject, index) => {
    const html = DOMPurify.sanitize(foreignObject.innerHTML, { USE_PROFILES: { html: true } });
    foreignObject.replaceChildren();
    foreignObject.setAttribute("data-mosaic-mermaid-label", String(index));
    return html;
  });
  const cleanSvg = DOMPurify.sanitize(new XMLSerializer().serializeToString(root), {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_TAGS: ["foreignObject"],
  });
  const container = document.createElement("div");
  container.innerHTML = cleanSvg;
  for (const foreignObject of container.querySelectorAll<SVGElement>("foreignObject")) {
    const index = Number(foreignObject.dataset.mosaicMermaidLabel);
    if (Number.isInteger(index) && labels[index] !== undefined) foreignObject.innerHTML = labels[index];
    foreignObject.removeAttribute("data-mosaic-mermaid-label");
  }
  return container.innerHTML;
}
