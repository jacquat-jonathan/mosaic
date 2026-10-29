import type { CSSProperties, HTMLAttributes } from "react";
import { useSettings } from "../state/settings";
import "../design-system/tokens.css";
import "../design-system/controls.css";

/** App preference adapter. The design-system primitives remain independent of app state. */
export function DesignSystemScope({
  as: Element = "div",
  className,
  style,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: "div" | "nav" | "header" | "main" | "aside" }) {
  const theme = useSettings((s) => s.theme);
  const density = useSettings((s) => s.density);
  return (
    <Element
      {...props}
      className={["mosaic-ds", className].filter(Boolean).join(" ")}
      data-theme={theme}
      data-density={density}
      style={{ "--mds-accent": "var(--accent)", ...style } as CSSProperties}
    />
  );
}
