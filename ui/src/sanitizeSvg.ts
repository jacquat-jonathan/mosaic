import DOMPurify from "dompurify";

/**
 * Cleans SVG markup from a renderer (Graphviz, canvases) before it is put into the page. Renderers
 * copy attributes from the diagram source (DOT `URL`/`href`, labels…) into the SVG, so scripts,
 * event handlers and `javascript:` links are removed here instead of relying on the CSP alone.
 * Mermaid is not passed through this: its HTML labels live in `foreignObject`, which DOMPurify
 * empties, and its `securityLevel: "strict"` already sanitizes every label it draws.
 */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
}
