// The shape palette under the canvas toolbar's Shape button: click a shape to place it in the middle
// of the view, or drag it to where it should go.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { SHAPES, SHAPE_GROUPS, ShapePreview, type ShapeName } from "../../diagrams/shapes";
import { ICONS, ICON_NAMES, iconLabel } from "../../diagrams/icons";

/** Drag data for a shape or icon from the palette onto the canvas. */
export const SHAPE_DRAG = "application/x-mosaic-shape";
export type PaletteItem = { shape: ShapeName } | { icon: string };

export function ShapePalette({ anchor, onPick, onClose }: { anchor: DOMRect; onPick(item: PaletteItem): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const tile = (item: PaletteItem, label: string, picture: React.ReactNode) => (
    <button
      key={label}
      className="palette-tile"
      title={`${label}: click to add, or drag onto the canvas`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SHAPE_DRAG, JSON.stringify(item));
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => onPick(item)}
    >
      {picture}
      <span>{label.replace(/ \(.*\)$/, "")}</span>
    </button>
  );
  return createPortal(
    <div ref={ref} className="shape-palette" style={{ top: anchor.bottom + 6, left: Math.max(8, Math.min(anchor.left - 200, window.innerWidth - 470)) }}>
      {SHAPE_GROUPS.map((g) => (
        <section key={g}>
          <h4>{g}</h4>
          <div className="palette-grid">{SHAPES.filter((s) => s.group === g).map((s) => tile({ shape: s.name }, s.label, <ShapePreview shape={s.name} />))}</div>
        </section>
      ))}
      <section>
        <h4>Icons (network, cloud)</h4>
        <div className="palette-grid">
          {ICON_NAMES.map((name) => {
            const Icon = ICONS[name];
            return tile({ icon: name }, iconLabel(name), <Icon size={18} strokeWidth={1.6} />);
          })}
        </div>
      </section>
    </div>,
    document.body,
  );
}
