import type { ReactNode } from "react";
import { DesignSystemScope } from "../views/DesignSystemScope";
import "./documentControls.css";

export function Segmented<const T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange(v: T): void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? "active" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="viewer-toolbar">{children}</div>;
}

/** Scoped chrome around a specialized document renderer. */
export function DocumentToolbar({ children, label }: { children: ReactNode; label: string }) {
  return (
    <DesignSystemScope className="document-toolbar" role="group" aria-label={label}>
      {children}
    </DesignSystemScope>
  );
}
