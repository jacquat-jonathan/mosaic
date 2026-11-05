import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useWorkspace, type Buffer } from "../state/workspace";
import { useVault } from "../state/vault";
import { api } from "../ipc/api";
import { errorMessage } from "../ipc/types";
import { diffLines, type DiffLine } from "../diff";
import { Button, Dialog, Notice } from "../design-system/components";
import { DiffView } from "../design-system/patterns";
import { DesignSystemScope } from "./DesignSystemScope";
import "../design-system/patterns.css";
import "./conflictBar.css";

/** Shown when disk and an open buffer disagree; every resolution stays explicit. */
export function ConflictBar({ buffer }: { buffer: Buffer }) {
  const ws = useWorkspace.getState;
  const scopeId = useId();
  const root = useVault((s) => s.vault?.root);
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true),
    lock = useRef(false),
    generation = useRef(0);
  const latestPath = useRef(buffer.path);
  latestPath.current = buffer.path;
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
    setComparing(false);
    setActionError(null);
  }, [root, buffer.path]);
  const run = async (action: () => void | Promise<void>) => {
    if (lock.current || useVault.getState().vault?.root !== root) return;
    const pane = document.getElementById(scopeId)?.closest(".pane");
    const ticket = ++generation.current,
      path = buffer.path;
    const current = () =>
      mounted.current &&
      generation.current === ticket &&
      latestPath.current === path &&
      useVault.getState().vault?.root === root;
    lock.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await action();
      if (!current()) return;
      const next = ws().buffers[path];
      if (next?.error) {
        setActionError(next.error);
        return;
      }
      if (next?.conflict) {
        setActionError("The file changed again. Compare its latest version.");
        return;
      }
      setComparing(false);
      requestAnimationFrame(() => {
        if (current()) pane?.querySelector<HTMLElement>(".cm-content")?.focus();
      });
    } catch (cause) {
      if (current()) setActionError(errorMessage(cause));
    } finally {
      if (generation.current === ticket) {
        lock.current = false;
        if (current()) setBusy(false);
      }
    }
  };
  const deleted = buffer.deleted && buffer.dirty;
  const conflict = !!buffer.conflict;
  const failed = !!buffer.error && buffer.content !== null;
  if (!deleted && !conflict && !failed && !comparing && !actionError) return null;
  return (
    <>
      <DesignSystemScope id={scopeId} className="conflict-notices">
        {(deleted || conflict || failed) && (
          <Notice tone={failed && !deleted && !conflict ? "error" : "warning"} role="alert">
            <span>
              {deleted
                ? "This file was deleted on disk, but you have unsaved changes."
                : conflict
                  ? "This file changed on disk while you were editing it."
                  : `Couldn't save: ${buffer.error}`}
            </span>
            <div className="conflict-actions">
              {deleted ? (
                <>
                  <Button disabled={busy} onClick={() => void run(() => ws().keepMine(buffer.path))}>
                    Save my version
                  </Button>
                  <Button disabled={busy} onClick={() => void run(() => ws().discardDeleted(buffer.path))}>
                    Discard
                  </Button>
                </>
              ) : conflict ? (
                <>
                  <Button ref={opener} disabled={busy} onClick={() => setComparing(true)}>
                    Compare
                  </Button>
                  <Button disabled={busy} onClick={() => void run(() => ws().reload(buffer.path))}>
                    Load disk version
                  </Button>
                  <Button disabled={busy} onClick={() => void run(() => ws().keepMine(buffer.path))}>
                    Keep mine
                  </Button>
                </>
              ) : (
                <Button disabled={busy} onClick={() => void run(() => ws().save(buffer.path))}>
                  Retry
                </Button>
              )}
            </div>
          </Notice>
        )}
        {busy && !comparing && <Notice>Updating file…</Notice>}
        {actionError && !comparing && <Notice tone="error">{actionError}</Notice>}
      </DesignSystemScope>
      {comparing && (
        <CompareModal
          key={`${root}:${buffer.path}`}
          buffer={buffer}
          root={root}
          busy={busy}
          actionError={actionError}
          returnFocusRef={opener}
          onClose={() => setComparing(false)}
          onLoad={() => run(() => ws().reload(buffer.path))}
          onKeep={() => run(() => ws().keepMine(buffer.path))}
        />
      )}
    </>
  );
}

function CompareModal({
  buffer,
  root,
  busy,
  actionError,
  returnFocusRef,
  onClose,
  onLoad,
  onKeep,
}: {
  buffer: Buffer;
  root?: string;
  busy: boolean;
  actionError: string | null;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  onLoad(): Promise<void>;
  onKeep(): Promise<void>;
}) {
  const [lines, setLines] = useState<DiffLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true;
    setLines(null);
    setError(null);
    void api.read(buffer.path).then(
      (disk) => {
        if (live && useVault.getState().vault?.root === root)
          setLines(diffLines(disk.content ?? "", buffer.content ?? ""));
      },
      (cause) => {
        if (live && useVault.getState().vault?.root === root) setError(errorMessage(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [buffer.path, buffer.content, buffer.conflict?.diskHash, root, retry]);
  return (
    <DesignSystemScope>
      <Dialog
        open
        title="Disk version → your version"
        size="wide"
        description="Lines only on disk are red; lines only in your unsaved version are green."
        initialFocusRef={close}
        returnFocusRef={returnFocusRef}
        onClose={onClose}
        dismissible={!busy}
        actions={
          <>
            <Button ref={close} disabled={busy} onClick={onClose}>
              Close
            </Button>
            <Button variant="secondary" disabled={busy || !lines || !!error} onClick={() => void onLoad()}>
              Load disk version
            </Button>
            <Button variant="secondary" disabled={busy || !lines || !!error} onClick={() => void onKeep()}>
              Keep mine
            </Button>
          </>
        }
      >
        {busy && <Notice>Updating file…</Notice>}
        {actionError && <Notice tone="error">{actionError}</Notice>}
        {error ? (
          <>
            <Notice tone="error">Couldn't compare this file: {error}</Notice>
            <div>
              <Button
                disabled={busy}
                onClick={() => {
                  setRetry((n) => n + 1);
                  requestAnimationFrame(() => close.current?.focus());
                }}
              >
                Retry comparison
              </Button>
            </div>
          </>
        ) : !lines ? (
          <Notice>Loading comparison…</Notice>
        ) : (
          <DiffView
            label="Disk version compared with your unsaved version"
            lines={lines.map((line) => ({
              type: line.op === "same" ? "context" : line.op === "del" ? "remove" : "add",
              text: line.text,
            }))}
          />
        )}
      </Dialog>
    </DesignSystemScope>
  );
}
