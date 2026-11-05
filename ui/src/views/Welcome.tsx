import { useEffect, useRef, useState } from "react";
import { FolderOpen, FolderPlus } from "lucide-react";
import { Button, Notice } from "../design-system/components";
import { createVault, openVaultFolder } from "../actions";
import { errorMessage } from "../ipc/types";
import { useVault } from "../state/vault";
import { DesignSystemScope } from "./DesignSystemScope";
import "./welcome.css";

export function Welcome({ loading = false }: { loading?: boolean }) {
  const [busy, setBusy] = useState<"open" | "create" | null>(null);
  const [error, setError] = useState(() => useVault.getState().error);
  const lock = useRef(false);
  const mounted = useRef(true);
  const opener = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!busy && opener.current?.isConnected) {
      opener.current.focus({ preventScroll: true });
      opener.current = null;
    }
  }, [busy]);
  const current = () => mounted.current && !useVault.getState().vault;
  const act = async (kind: "open" | "create", button: HTMLButtonElement) => {
    if (loading || lock.current || !current()) return;
    lock.current = true;
    opener.current = button;
    setBusy(kind);
    setError(null);
    useVault.getState().setError(null);
    try {
      if (kind === "open") await openVaultFolder(current);
      else await createVault(current);
      if (current()) setError(useVault.getState().error);
    } catch (cause) {
      if (current()) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  return (
    <DesignSystemScope as="main" className="welcome-page" aria-label="Welcome" data-tauri-drag-region>
      <img src="/icon.png" alt="" width={96} height={96} />
      <h1>Mosaic</h1>
      <p className="mds-hint">Open a folder to use it as your vault. Existing Obsidian vaults work as they are.</p>
      <div className="welcome-actions">
        <Button
          variant="secondary"
          disabled={loading || !!busy}
          onClick={(event) => void act("open", event.currentTarget)}
        >
          <FolderOpen aria-hidden="true" />
          Open folder…
        </Button>
        <Button
          variant="secondary"
          disabled={loading || !!busy}
          onClick={(event) => void act("create", event.currentTarget)}
        >
          <FolderPlus aria-hidden="true" />
          Create new vault…
        </Button>
      </div>
      {(loading || busy) && (
        <Notice>{loading ? "Opening Mosaic…" : busy === "open" ? "Opening folder…" : "Creating vault…"}</Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </DesignSystemScope>
  );
}
