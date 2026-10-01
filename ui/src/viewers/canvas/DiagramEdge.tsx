// A canvas connection with diagram styles: solid / dashed / dotted lines, UML arrowheads at either
// end, a middle label and labels near each end (multiplicities like "1..*").

import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, type EdgeProps, type Edge } from "@xyflow/react";
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

export function DiagramEdge(props: EdgeProps<DiagramFlowEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, label, selected } = props;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  if (!data) return null;
  const { edge, color, flow } = data;
  const ends = edgeEnds(edge);
  const base = typeof edge.thickness === "number" && edge.thickness > 0 ? edge.thickness : 2;
  const width = selected ? base + 1 : base;
  const from = endLabelAt(sourceX, sourceY, sourcePosition, "from");
  const to = endLabelAt(targetX, targetY, targetPosition, "to");
  const cls = flow === "on" ? "edge-flow" : flow === "dim" ? "edge-dim" : undefined;
  return (
    <g className={cls}>
      <BaseEdge
        id={id}
        path={path}
        markerStart={ends.from === "none" ? undefined : `url(#${markerId(ends.from, color)})`}
        markerEnd={ends.to === "none" ? undefined : `url(#${markerId(ends.to, color)})`}
        style={{ stroke: color, strokeWidth: width, strokeDasharray: dashArray(edge.line as string | undefined, width) }}
        interactionWidth={18}
      />
      <EdgeLabelRenderer>
        {typeof label === "string" && label && (
          <div className={`edge-label nodrag nopan ${cls ?? ""}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {label}
          </div>
        )}
        {typeof edge.fromLabel === "string" && edge.fromLabel && (
          <div className={`edge-end-label ${cls ?? ""}`} style={{ transform: `translate(-50%, -50%) translate(${from.x}px, ${from.y}px)` }}>
            {edge.fromLabel}
          </div>
        )}
        {typeof edge.toLabel === "string" && edge.toLabel && (
          <div className={`edge-end-label ${cls ?? ""}`} style={{ transform: `translate(-50%, -50%) translate(${to.x}px, ${to.y}px)` }}>
            {edge.toLabel}
          </div>
        )}
      </EdgeLabelRenderer>
    </g>
  );
}
