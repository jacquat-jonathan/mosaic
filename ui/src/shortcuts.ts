import { useEffect } from "react";
import { useVault } from "./state/vault";
import { commands, keysFor, matches } from "./commands";

/** App-wide keyboard shortcuts, taken from the command registry. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !useVault.getState().vault) return;
      const cmd = commands().find((c) => {
        const k = keysFor(c);
        return k && matches(k, e);
      });
      if (!cmd || !(cmd.when?.() ?? true)) return;
      e.preventDefault();
      cmd.run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
