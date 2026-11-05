// The shape palette under the canvas toolbar's Shape button: click a shape to place it in the middle
// of the view, or drag it to where it should go.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import { Button, IconButton } from "../../design-system/components";
import { DesignSystemScope } from "../../views/DesignSystemScope";
import { createPortal } from "react-dom";
import { SHAPES, SHAPE_GROUPS, ShapePreview, type ShapeName } from "../../diagrams/shapes";
import { ICONS, ICON_NAMES, iconLabel } from "../../diagrams/icons";

/** Drag data for a shape or icon from the palette onto the canvas. */
export const SHAPE_DRAG = "application/x-mosaic-shape";
export type PaletteItem = { shape: ShapeName } | { icon: string };

export function ShapePalette({
  anchor,
  onPick,
  onClose,
  returnFocusRef,
}: {
  anchor: DOMRect;
  onPick(item: PaletteItem): void;
  onClose(): void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const restore = useRef(true);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 460, maxHeight: 500 });
  useLayoutEffect(() => {
    const place = () => {
      const scale = Number.parseFloat(document.documentElement.style.zoom) || 1;
      const width = Math.min(460, (window.innerWidth - 16) / scale);
      const top = Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - 240));
      const left = Math.max(8, Math.min(anchor.left - 200, window.innerWidth - width * scale - 8));
      setPosition({ left: left / scale, top: top / scale, width, maxHeight: (window.innerHeight - top - 8) / scale });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  useEffect(() => {
    restore.current = true;
    ref.current?.querySelector<HTMLButtonElement>(".palette-tile")?.focus({ preventScroll: true });
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node) && !returnFocusRef.current?.contains(event.target as Node)) {
        restore.current = false;
        close.current();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      if (restore.current) returnFocusRef.current?.focus();
    };
  }, [returnFocusRef]);
  const tile = (item: PaletteItem, label: string, picture: React.ReactNode) => (
    <Button
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
    </Button>
  );
  return createPortal(
    <div ref={ref} style={{ position: "fixed", zIndex: 70, ...position }}>
      <DesignSystemScope className="canvas-palette" role="dialog" aria-label="Shapes and icons">
        <header>
          <h3>Shapes and icons</h3>
          <IconButton label="Close shapes" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        {SHAPE_GROUPS.map((g) => (
          <section key={g}>
            <h4>{g}</h4>
            <div className="palette-grid">
              {SHAPES.filter((s) => s.group === g).map((s) =>
                tile({ shape: s.name }, s.label, <ShapePreview shape={s.name} />),
              )}
            </div>
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
      </DesignSystemScope>
    </div>,
    document.body,
  );
}
