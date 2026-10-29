import { useEffect, useId, useRef, useState } from "react";
import { Button, Notice } from "../design-system/components";
import { errorMessage } from "../ipc/types";
import { useVault } from "../state/vault";
import { DesignSystemScope } from "./DesignSystemScope";
import "./workspaceNotices.css";
export function WorkspaceNotices() {
  const vault = useVault((s) => s.vault),
    offline = useVault((s) => s.offline),
    renames = useVault((s) => s.unfinishedRenames);
  const [pending, setPending] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const id = useId(),
    generation = useRef(0),
    lock = useRef(false),
    mounted = useRef(true);
  const root = vault?.root;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    generation.current++;
    lock.current = false;
    setPending(null);
    setError(null);
  }, [root]);
  const run = async (key: string, action: () => Promise<unknown>) => {
    if (lock.current || !root || useVault.getState().vault?.root !== root) return;
    const ticket = ++generation.current,
      scope = document.getElementById(id),
      previous = document.activeElement,
      main = scope?.closest("main");
    const current = () => mounted.current && ticket === generation.current && useVault.getState().vault?.root === root;
    lock.current = true;
    setPending(key);
    setError(null);
    try {
      const result = await action();
      if (!current()) return;
      if (result === false) setError(useVault.getState().error ?? "Some links could not be fixed. Try again.");
      requestAnimationFrame(() => {
        if (!current()) return;
        if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected) previous.focus();
        else main?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], .pane')?.focus();
      });
    } catch (cause) {
      if (current()) setError(errorMessage(cause));
    } finally {
      if (ticket === generation.current) {
        lock.current = false;
        if (current()) setPending(null);
      }
    }
  };
  if (!vault || (!offline && !vault.history_warning && !renames.length && !error)) return null;
  return (
    <DesignSystemScope
      id={id}
      className="workspace-notices"
      role="region"
      aria-label="Workspace notices"
      aria-busy={!!pending}
    >
      {offline && (
        <Notice tone="warning" role="alert">
          <span>
            The vault folder is unavailable (disk ejected or folder moved). Unsaved changes are kept in memory.
          </span>
          <Button
            disabled={!!pending}
            onClick={() =>
              void run("reconnect", () => useVault.getState().openVault(vault.root, { preserveWorkspace: true }))
            }
          >
            {pending === "reconnect" ? "Reconnecting…" : "Retry"}
          </Button>
        </Notice>
      )}
      {vault.history_warning && (
        <Notice tone="warning" role="alert">
          <span>{vault.history_warning}</span>
        </Notice>
      )}
      {renames.map((op) => (
        <Notice key={op.id} tone="warning" role="alert">
          <span>
            Moving {op.from} to {op.to} didn't finish: some links may still point to the old name.
          </span>
          <Button
            disabled={!!pending}
            onClick={() => void run(String(op.id), () => useVault.getState().fixLinks(op.id))}
          >
            {pending === String(op.id) ? "Fixing links…" : "Fix links"}
          </Button>
        </Notice>
      ))}
      {error && <Notice tone="error">{error}</Notice>}
    </DesignSystemScope>
  );
}
