import { useEffect } from "react";
import { useWorkspace } from "./state/workspace";
import { parentOf, useVault } from "./state/vault";
import { newNote } from "./actions";

/** App-wide keyboard shortcuts. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !useVault.getState().vault) return;
      const ws = useWorkspace.getState();
      const key = e.key.toLowerCase();
      if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        const active = ws.activePath();
        void newNote(active ? parentOf(active) : "");
      } else if (key === "w") {
        const active = ws.activePath();
        if (active) {
          e.preventDefault();
          ws.closeTab(ws.focused, active);
        }
      } else if (key === "s") {
        e.preventDefault();
        const active = ws.activePath();
        if (active) void ws.save(active);
      } else if (key === "\\") {
        e.preventDefault();
        ws.split(e.shiftKey ? "column" : "row");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
