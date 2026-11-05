import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button, Notice } from "../design-system/components";
import { openInDefaultApp } from "../ipc/api";
import { errorMessage } from "../ipc/types";
import { useVault } from "../state/vault";
import { DesignSystemScope } from "../views/DesignSystemScope";
import "./documentStates.css";
export function UnsupportedFile({ path, message }: { path: string; message: string }) {
  const root = useVault((s) => s.vault?.root);
  const [refused, setRefused] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const lock = useRef(false),
    generation = useRef(0),
    mounted = useRef(true),
    latest = useRef(path);
  latest.current = path;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    generation.current++;
    lock.current = false;
    setBusy(false);
    setRefused(null);
  }, [path, root]);
  const open = async () => {
    if (lock.current || useVault.getState().vault?.root !== root) return;
    const ticket = ++generation.current;
    const current = () =>
      mounted.current &&
      generation.current === ticket &&
      latest.current === path &&
      useVault.getState().vault?.root === root;
    lock.current = true;
    setBusy(true);
    setRefused(null);
    try {
      await openInDefaultApp(path);
    } catch (cause) {
      if (current()) setRefused(errorMessage(cause));
    } finally {
      if (generation.current === ticket) {
        lock.current = false;
        if (current()) setBusy(false);
      }
    }
  };
  return (
    <DesignSystemScope className="document-state" role="region" aria-label="File preview unavailable">
      <Notice>{message}</Notice>
      <div>
        <Button variant="secondary" disabled={busy} onClick={() => void open()}>
          <ExternalLink size={14} />
          {busy ? "Opening…" : "Open in default app"}
        </Button>
      </div>
      {refused && <Notice tone="error">{refused}</Notice>}
    </DesignSystemScope>
  );
}
