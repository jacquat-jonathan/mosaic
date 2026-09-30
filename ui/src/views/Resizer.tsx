/** Drag handle on the edge of a side panel. `side` is the edge it sits on; double-click resets the width. */
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
  return (
    <div
      className={`panel-resizer ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      title="Drag to resize · double-click to reset"
      onDoubleClick={onReset}
      onMouseDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        // A handle on the panel's right edge grows it when dragged right; on the left edge, when dragged left.
        const dir = side === "right" ? 1 : -1;
        const move = (ev: MouseEvent) => onResize(width + (ev.clientX - startX) * dir);
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          document.body.classList.remove("resizing");
        };
        document.body.classList.add("resizing");
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
    />
  );
}
