// A canvas connection with diagram styles: solid / dashed / dotted lines, UML arrowheads at either
// end, a middle label and labels near each end (multiplicities like "1..*").

import { useState } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, useNodes, useStore, type EdgeProps, type Edge } from "@xyflow/react";
import { midpoint, roundedPath, routeAround, type Box } from "../../diagrams/route";
import { dashArray, isEnd, markerId, type EndName } from "../../diagrams/shapes";
import type { CanvasEdge } from "./jsonCanvas";

export type DiagramEdgeData = { edge: CanvasEdge; color: string; flow?: "on" | "dim" };
export type DiagramFlowEdge = Edge<DiagramEdgeData, "diagram">;

/** The arrowheads an edge shows: JSON Canvas defaults to an arrow at the end and none at the start. */
export function edgeEnds(e: CanvasEdge): { from: EndName; to: EndName } {
  return { from: isEnd(e.fromEnd) ? e.fromEnd : "none", to: isEnd(e.toEnd) ? e.toEnd : "arrow" };
}

/**
 * Where an end label sits: a little away from the card, the start label on one side of the line and
 * the end label on the other, so they don't collide on short connections.
 */
function endLabelAt(x: number, y: number, side: Position, which: "from" | "to"): { x: number; y: number } {
  const out = 20;
  const beside = which === "from" ? -12 : 12;
  switch (side) {
    case Position.Left:
      return { x: x - out, y: y + beside };
    case Position.Right:
      return { x: x + out, y: y + beside };
    case Position.Top:
      return { x: x + beside * 1.6, y: y - out };
    default:
      return { x: x + beside * 1.6, y: y + out };
  }
}

const outward: Record<Position, { x: number; y: number }> = {
  [Position.Left]: { x: -1, y: 0 },
  [Position.Right]: { x: 1, y: 0 },
  [Position.Top]: { x: 0, y: -1 },
  [Position.Bottom]: { x: 0, y: 1 },
};

/** Zoomed out this far, labels hide until the connection or one of its cards is hovered. */
const CROWDED_ZOOM = 0.6;

export function DiagramEdge(props: EdgeProps<DiagramFlowEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, label, selected } = props;
  const [hovered, setHovered] = useState(false);
  const zoom = useStore((s) => s.transform[2]);
  const nodes = useNodes();
  const route = data?.edge.route;
  let path: string;
  let labelX: number;
  let labelY: number;
  if (route === "straight") {
    path = `M${sourceX},${sourceY} L${targetX},${targetY}`;
    [labelX, labelY] = [(sourceX + targetX) / 2, (sourceY + targetY) / 2];
  } else if (route === "orthogonal") {
    // Every card is in the way except groups and frames, which connections may cross.
    const obstacles: Box[] = nodes
      .filter((n) => n.zIndex !== -1)
      .map((n) => ({ x: n.position.x, y: n.position.y, width: n.measured?.width ?? n.width ?? 0, height: n.measured?.height ?? n.height ?? 0 }));
    const pts = routeAround({ x: sourceX, y: sourceY }, outward[sourcePosition], { x: targetX, y: targetY }, outward[targetPosition], obstacles);
    path = roundedPath(pts);
    ({ x: labelX, y: labelY } = midpoint(pts));
  } else {
    [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  }
  if (!data) return null;
  const { edge, color, flow } = data;
  const showLabels = zoom >= CROWDED_ZOOM || hovered || selected || flow === "on";
  const ends = edgeEnds(edge);
  const base = typeof edge.thickness === "number" && edge.thickness > 0 ? edge.thickness : 2;
  const width = selected ? base + 1 : base;
  const from = endLabelAt(sourceX, sourceY, sourcePosition, "from");
  const to = endLabelAt(targetX, targetY, targetPosition, "to");
  const cls = flow === "on" ? "edge-flow" : flow === "dim" ? "edge-dim" : undefined;
  return (
    <g className={cls} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <BaseEdge
        id={id}
        path={path}
        markerStart={ends.from === "none" ? undefined : `url(#${markerId(ends.from, color)})`}
        markerEnd={ends.to === "none" ? undefined : `url(#${markerId(ends.to, color)})`}
        style={{ stroke: color, strokeWidth: width, strokeDasharray: dashArray(edge.line as string | undefined, width) }}
        interactionWidth={18}
      />
      <EdgeLabelRenderer>
        {showLabels && typeof label === "string" && label && (
          <div className={`edge-label nodrag nopan ${cls ?? ""}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {label}
          </div>
        )}
        {showLabels && typeof edge.fromLabel === "string" && edge.fromLabel && (
          <div className={`edge-end-label ${cls ?? ""}`} style={{ transform: `translate(-50%, -50%) translate(${from.x}px, ${from.y}px)` }}>
            {edge.fromLabel}
          </div>
        )}
        {showLabels && typeof edge.toLabel === "string" && edge.toLabel && (
          <div className={`edge-end-label ${cls ?? ""}`} style={{ transform: `translate(-50%, -50%) translate(${to.x}px, ${to.y}px)` }}>
            {edge.toLabel}
          </div>
        )}
      </EdgeLabelRenderer>
    </g>
  );
}
