import { useEffect } from "react";
import { useVault } from "./state/vault";
import { commands, matches } from "./commands";

/** App-wide keyboard shortcuts, taken from the command registry. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !useVault.getState().vault) return;
      const cmd = commands().find((c) => c.keys && matches(c.keys, e));
      if (!cmd || !(cmd.when?.() ?? true)) return;
      e.preventDefault();
      cmd.run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
