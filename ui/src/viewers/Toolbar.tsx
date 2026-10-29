import type { ReactNode } from "react";
import { DesignSystemScope } from "../views/DesignSystemScope";
import "./documentControls.css";

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
