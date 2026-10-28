import { useEffect, useRef } from "react";
import { clampPanel, PANEL_MIN, PANEL_MAX } from "../state/ui";
import { DesignSystemScope } from "./DesignSystemScope";
import "./resizer.css";

export function Resizer({
  side,
  width,
  onResize,
  onReset,
  label,
}: {
  side: "left" | "right";
  width: number;
  onResize(width: number): void;
  onReset(): void;
  label: string;
}) {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return (
    <DesignSystemScope
      className={`panel-resizer ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={PANEL_MIN}
      aria-valuemax={PANEL_MAX}
      aria-valuetext={`Preferred width ${Math.round(width)} pixels`}
      tabIndex={0}
      title="Drag or use arrow keys to resize · Enter or double-click to reset"
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
        event.preventDefault();
        if (event.key === "Enter") onReset();
        else if (event.key === "Home") onResize(PANEL_MIN);
        else if (event.key === "End") onResize(PANEL_MAX);
        else onResize(clampPanel(width + (event.key === "ArrowRight" ? 10 : -10) * (side === "right" ? 1 : -1)));
      }}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        cleanup.current?.();
        const start = event.clientX,
          parent = event.currentTarget.parentElement;
        const layoutWidth = parent?.offsetWidth || width;
        const renderedWidth = parent?.getBoundingClientRect().width || layoutWidth;
        const scale = renderedWidth > 0 && layoutWidth > 0 ? renderedWidth / layoutWidth : 1;
        const direction = side === "right" ? 1 : -1;
        const move = (next: MouseEvent) =>
          onResize(clampPanel(layoutWidth + ((next.clientX - start) * direction) / scale));
        const end = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", end);
          document.body.classList.remove("resizing");
          cleanup.current = null;
        };
        cleanup.current = end;
        document.body.classList.add("resizing");
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", end);
      }}
    />
  );
}
