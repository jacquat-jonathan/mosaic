import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { RotateCcw } from "lucide-react";
import { Button, Dialog, Notice } from "../design-system/components";
import { DiffView } from "../design-system/patterns";
import { api } from "../ipc/api";
import { errorMessage, type Version } from "../ipc/types";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { diffLines } from "../diff";
import { ago } from "../time";
import { what, who } from "./history";
import { DesignSystemScope } from "./DesignSystemScope";
import "../design-system/patterns.css";
import "./historyModal.css";

export function HistoryModal() {
  const spec = useUi((state) => state.history);
  const root = useVault((state) => state.vault?.root);
  return spec ? <History key={spec.path} path={spec.path} focus={spec.focus} root={root} /> : null;
}
function History({ path, focus, root }: { path: string; focus?: number; root?: string }) {
  const close = useUi((state) => state.closeHistory);
  const revision = useVault((state) => state.revision);
  const [initialRoot] = useState(root);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [selected, setSelected] = useState<number | null>(focus ?? null);
  const [content, setContent] = useState<string | null | undefined>();
  const [current, setCurrent] = useState<{ text: string; hash: string } | null | undefined>();
  const [listError, setListError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [contentTick, setContentTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  const options = useRef(new Map<number, HTMLButtonElement>());
  const restoreButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnRestoreFocus = useRef(false);
  const currentVault = () => mounted.current && !!initialRoot && useVault.getState().vault?.root === initialRoot;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (root !== initialRoot) close();
  }, [root, initialRoot, close]);
  useEffect(() => {
    if (!initialRoot || root !== initialRoot) return;
    let live = true;
    setListError(null);
    setReadError(null);
    setCurrent(undefined);
    void api.fileHistory(path).then(
      (next) => {
        if (!live) return;
        setVersions(next);
        setSelected((previous) =>
          next.some((version) => version.id === previous && version.action !== "renamed")
            ? previous
            : (next.find((version) => version.action !== "renamed")?.id ?? null),
        );
      },
      (cause) => {
        if (live) setListError(errorMessage(cause));
      },
    );
    void api.read(path).then(
      (file) => {
        if (live) setCurrent({ text: file.content ?? "", hash: file.hash });
      },
      (cause) => {
        if (!live) return;
        if ((cause as { code?: string }).code === "not_found") setCurrent(null);
        else setReadError(errorMessage(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [path, revision, refreshTick, initialRoot, root]);
  const chosen = versions?.find((version) => version.id === selected);
  const chosenId = chosen?.id,
    chosenAction = chosen?.action;
  useEffect(() => {
    if (!initialRoot || root !== initialRoot) return;
    let live = true;
    setContent(undefined);
    setContentError(null);
    if (chosenId !== undefined && chosenAction !== "renamed")
      void api.versionContent(chosenId).then(
        (text) => {
          if (live) setContent(text);
        },
        (cause) => {
          if (live) setContentError(errorMessage(cause));
        },
      );
    return () => {
      live = false;
    };
  }, [chosenId, chosenAction, contentTick, initialRoot, root]);
  useEffect(() => {
    if (!busy && returnRestoreFocus.current) {
      (restoreButton.current?.disabled ? closeButton.current : restoreButton.current)?.focus({ preventScroll: true });
      returnRestoreFocus.current = false;
    }
  }, [busy]);
  const lines = useMemo(
    () =>
      content === undefined || content === null || current === undefined
        ? null
        : diffLines(content, current?.text ?? ""),
    [content, current],
  );
  const same = typeof content === "string" && !!current && content === current.text;
  const move = (event: KeyboardEvent<HTMLButtonElement>, id: number) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const enabled = (versions ?? []).filter((version) => version.action !== "renamed");
    const index = enabled.findIndex((version) => version.id === id);
    const next =
      event.key === "Home"
        ? enabled[0]
        : event.key === "End"
          ? enabled.at(-1)
          : enabled[Math.max(0, Math.min(enabled.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)))];
    if (next) {
      setSelected(next.id);
      setError(null);
      setRestored(false);
      options.current.get(next.id)?.focus();
    }
  };
  const restore = async () => {
    if (
      !currentVault() ||
      lock.current ||
      !chosen ||
      chosen.action === "renamed" ||
      typeof content !== "string" ||
      current === undefined ||
      same
    )
      return;
    lock.current = true;
    returnRestoreFocus.current = true;
    setBusy(true);
    setError(null);
    setRestored(false);
    try {
      await api.restoreVersion(path, chosen.id, current?.hash ?? null);
      if (!currentVault()) return;
      setRestored(true);
      setCurrent(undefined);
      setRefreshTick((tick) => tick + 1);
    } catch (cause) {
      if (currentVault()) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (currentVault()) setBusy(false);
    }
  };
  if (root !== initialRoot) return null;
  const name = path.split("/").pop()!.replace(/\.md$/, "");
  const selectVersion = (id: number) => {
    setSelected(id);
    setError(null);
    setRestored(false);
  };
  return (
    <DesignSystemScope className="history-dialog-scope">
      <Dialog
        open
        size="wide"
        title={`History of ${name}`}
        description={path}
        onClose={close}
        dismissible={!busy}
        actions={
          <>
            <Button ref={closeButton} disabled={busy} onClick={close}>
              Close
            </Button>
            <Button
              ref={restoreButton}
              variant="secondary"
              disabled={busy || !chosen || same || typeof content !== "string" || current === undefined || !!readError}
              onClick={() => void restore()}
            >
              <RotateCcw aria-hidden="true" />
              {busy ? "Restoring…" : "Restore this version"}
            </Button>
          </>
        }
      >
        {listError && (
          <Notice tone="error">
            {listError}
            <Button variant="secondary" onClick={() => setRefreshTick((tick) => tick + 1)}>
              Retry history
            </Button>
          </Notice>
        )}
        {versions === null ? (
          !listError && <Notice>Loading history…</Notice>
        ) : !versions.length ? (
          <Notice>
            No versions yet. Mosaic keeps one each time this file is changed by you, the command line or an AI agent.
          </Notice>
        ) : (
          <div className="history-columns">
            <ul className="history-version-list" role="listbox" aria-label="File versions">
              {versions.map((version) => (
                <li key={version.id} role="presentation">
                  <Button
                    role="option"
                    aria-selected={version.id === selected}
                    disabled={busy || version.action === "renamed"}
                    tabIndex={version.id === selected ? 0 : -1}
                    ref={(node) => {
                      if (node) options.current.set(version.id, node);
                      else options.current.delete(version.id);
                    }}
                    onKeyDown={(event) => move(event, version.id)}
                    onClick={() => selectVersion(version.id)}
                  >
                    <time
                      dateTime={new Date(version.time).toISOString()}
                      title={new Date(version.time).toLocaleString()}
                    >
                      {ago(version.time)}
                    </time>
                    <strong>{who(version)}</strong>
                    <span>{what(version)}</span>
                  </Button>
                </li>
              ))}
            </ul>
            <div className="history-comparison" aria-label="Version comparison" role="region">
              {readError && (
                <Notice tone="error">
                  {readError}
                  <Button variant="secondary" onClick={() => setRefreshTick((tick) => tick + 1)}>
                    Retry current file
                  </Button>
                </Notice>
              )}
              {contentError && (
                <Notice tone="error">
                  {contentError}
                  <Button variant="secondary" onClick={() => setContentTick((tick) => tick + 1)}>
                    Retry version
                  </Button>
                </Notice>
              )}
              {chosen && current !== undefined && (
                <p>
                  {current
                    ? "From this version to the file as it is now: red lines would come back, green lines would go."
                    : "The file doesn't exist now (it was deleted or moved). Restore brings this version back."}
                </p>
              )}
              {same && <Notice>This version is the same as the file now.</Notice>}
              {lines && !same && (
                <DiffView
                  label="Version comparison"
                  lines={lines.map((line) => ({
                    type: line.op === "add" ? "add" : line.op === "del" ? "remove" : "context",
                    text: line.text || " ",
                  }))}
                />
              )}
              {chosen && !readError && !contentError && (current === undefined || content === undefined) && (
                <Notice>Loading comparison…</Notice>
              )}
              {chosen && content === null && <Notice>This version has no text content to compare.</Notice>}
            </div>
          </div>
        )}
        {restored && <Notice>Version restored. The previous file remains available in history.</Notice>}
        {error && (
          <Notice tone="error">
            {error}
            <Button variant="secondary" onClick={() => setRefreshTick((tick) => tick + 1)}>
              Reload comparison
            </Button>
          </Notice>
        )}
      </Dialog>
    </DesignSystemScope>
  );
}
