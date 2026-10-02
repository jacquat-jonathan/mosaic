// Diagram shapes, borders, line styles and arrowheads for canvases. Names, sizes and how each shape is
// drawn live in crates/mosaic-core/src/diagram_format.json, shared with the write validator, the Rust
// renderer (agents' `render` tool) and docs/AGENTS.md.

import type { ReactElement } from "react";
import format from "../../../crates/mosaic-core/src/diagram_format.json";

export type ShapeName = keyof typeof format.shapes;
export type Border = (typeof format.borders)[number];
export type LineStyle = (typeof format.lines)[number];
export type EndName = keyof typeof format.ends;

/** How a shape is drawn (see "draw" in the format file). */
interface Draw {
  rect?: number | "pill";
  ellipse?: boolean;
  path?: string;
  extra?: string;
  inset?: number;
  special?: "actor" | "final" | "lifeline";
  solid?: boolean;
  hollow?: boolean;
  label?: boolean;
  behind?: boolean;
  decor?: string;
  compartments?: boolean;
}

export const SHAPES = Object.entries(format.shapes).map(([name, s]) => ({ name: name as ShapeName, ...s, draw: s.draw as Draw }));
const DRAW = Object.fromEntries(SHAPES.map((s) => [s.name, s.draw])) as Record<ShapeName, Draw>;
export const drawOf = (shape: ShapeName): Draw => DRAW[shape];
/** Shape menu sections, in the order they first appear in the format file. */
export const SHAPE_GROUPS = [...new Set(SHAPES.map((s) => s.group))];

/** Shapes that are symbols without a label (pseudo-states, bars, ports). */
export const LABELLESS = new Set(SHAPES.filter((s) => s.draw.label === false).map((s) => s.name));
/** Shapes drawn behind other cards, like groups. */
export const BACKGROUND = new Set(SHAPES.filter((s) => s.draw.behind).map((s) => s.name));
export const BORDERS = format.borders as Border[];
export const LINES = format.lines as LineStyle[];
export const ENDS = Object.entries(format.ends).map(([name, label]) => ({ name: name as EndName, label }));

export const isShape = (s: unknown): s is ShapeName => typeof s === "string" && s in format.shapes;
export const isEnd = (s: unknown): s is EndName => typeof s === "string" && s in format.ends;

/** Shapes drawn with CSS border-radius on the card itself (rectangles, ellipses); the others are SVG. */
export const CSS_SHAPES: Partial<Record<ShapeName, string>> = Object.fromEntries(
  SHAPES.flatMap((s) => (s.draw.ellipse ? [[s.name, "50%"]] : s.draw.rect !== undefined ? [[s.name, s.draw.rect === "pill" ? "9999px" : `${s.draw.rect}px`]] : [])),
);
/** Shapes filled with the line colour instead of the card colour. */
export const SOLID = new Set(SHAPES.filter((s) => s.draw.solid).map((s) => s.name));

export function dashArray(style: string | undefined, width = 2): string | undefined {
  if (style === "dashed") return `${width * 4} ${width * 3}`;
  if (style === "dotted") return `${width} ${width * 2}`;
  return undefined;
}

/**
 * SVG outlines in a 100×100 box, stretched to the card. `non-scaling-stroke` keeps the line width even
 * when the box isn't square. Extra lines (cylinder rim, process bars, note fold) have no fill.
 */
export const OUTLINES: Partial<Record<ShapeName, { body: string; extra?: string }>> = Object.fromEntries(
  SHAPES.filter((s) => s.draw.path).map((s) => [s.name, { body: s.draw.path!, extra: s.draw.extra }]),
);

export interface ShapeStyle {
  stroke: string;
  fill: string;
  border?: string;
}

/** CSS for a card drawn as a CSS shape, or null when the shape is an SVG outline. */
export function cssShape(shape: ShapeName, s: ShapeStyle): React.CSSProperties | null {
  const radius = CSS_SHAPES[shape];
  if (radius === undefined) return null;
  return {
    borderRadius: radius,
    borderColor: s.border === "none" ? "transparent" : s.stroke,
    borderStyle: s.border === "dashed" || s.border === "dotted" ? s.border : "solid",
    background: SOLID.has(shape) ? s.stroke : shape === "frame" ? "transparent" : s.fill,
  };
}

/** The SVG drawn behind a card's text, for shapes that aren't plain CSS boxes. */
export function ShapeOutline({ shape, style }: { shape: ShapeName; style: ShapeStyle }): ReactElement | null {
  const stroke = style.border === "none" ? "transparent" : style.stroke;
  const dash = dashArray(style.border);
  if (shape === "actor") {
    // A person: kept in proportion at the top of the card; the label goes underneath.
    return (
      <svg className="shape-outline shape-actor" viewBox="0 0 40 64" preserveAspectRatio="xMidYMin meet" aria-hidden>
        <g fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={dash}>
          <circle cx="20" cy="10" r="8" fill={style.fill} />
          <path d="M20,18 L20,42 M6,28 L34,28 M20,42 L8,62 M20,42 L32,62" />
        </g>
      </svg>
    );
  }
  if (shape === "final") {
    return (
      <svg className="shape-outline" viewBox="0 0 34 34" aria-hidden>
        <circle cx="17" cy="17" r="15.5" fill="var(--bg)" stroke={stroke} strokeWidth="2" />
        <circle cx="17" cy="17" r="9.5" fill={style.stroke} />
      </svg>
    );
  }
  if (shape === "lifeline") {
    // A head box with the participant's name, and the dashed line of its life below it.
    return (
      <>
        <div className="lifeline-head" style={{ borderColor: stroke, background: style.fill, borderStyle: dash ? style.border : "solid" }} />
        <svg className="lifeline-line" aria-hidden>
          <line x1="50%" y1="0" x2="50%" y2="100%" stroke={stroke} strokeWidth="1.5" strokeDasharray="6 5" />
        </svg>
      </>
    );
  }
  const o = OUTLINES[shape];
  if (!o) return null;
  const decor = DRAW[shape].decor;
  return (
    <>
      <svg className="shape-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <path d={o.body} fill={style.fill} stroke={stroke} strokeWidth="2" strokeDasharray={dash} vectorEffect="non-scaling-stroke" />
        {o.extra && <path d={o.extra} fill="none" stroke={stroke} strokeWidth="2" strokeDasharray={dash} vectorEffect="non-scaling-stroke" />}
      </svg>
      {decor && (
        // Small fixed-size UML icon in the top-right corner (from the format file, not stretched).
        <svg className="shape-icon" viewBox="0 0 18 18" aria-hidden>
          <g fill={style.fill} stroke={stroke} strokeWidth="1.4" dangerouslySetInnerHTML={{ __html: decor }} />
        </svg>
      )}
    </>
  );
}

/** Markers for every arrowhead and colour in use, referenced by edges as `url(#…)`. */
export const markerId = (end: EndName, color: string) => `mosaic-end-${end}-${color.replace(/[^a-z0-9]/gi, "")}`;

export function EdgeMarkers({ used }: { used: { end: EndName; color: string }[] }) {
  const bg = "var(--bg)";
  return (
    <svg className="edge-markers" aria-hidden>
      <defs>
        {used.map(({ end, color }) => (
          <marker
            key={markerId(end, color)}
            id={markerId(end, color)}
            viewBox="0 0 20 20"
            refX={end === "diamond" || end === "diamond-open" ? 19 : end === "circle" ? 17 : 18}
            refY="10"
            markerWidth="16"
            markerHeight="16"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            {end === "arrow" && <path d="M2,3 L18,10 L2,17 Z" fill={color} />}
            {end === "triangle" && <path d="M2,3 L18,10 L2,17 Z" fill={bg} stroke={color} strokeWidth="1.6" strokeLinejoin="round" />}
            {end === "open" && <path d="M3,3 L18,10 L3,17" fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />}
            {end === "diamond" && <path d="M1,10 L10,4 L19,10 L10,16 Z" fill={color} />}
            {end === "diamond-open" && <path d="M1,10 L10,4 L19,10 L10,16 Z" fill={bg} stroke={color} strokeWidth="1.6" strokeLinejoin="round" />}
            {end === "circle" && <circle cx="11" cy="10" r="6" fill={bg} stroke={color} strokeWidth="1.6" />}
          </marker>
        ))}
      </defs>
    </svg>
  );
}
