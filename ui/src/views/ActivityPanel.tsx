import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, FilePenLine, FilePlus2, FileX2, FolderInput, History as HistoryIcon, Inbox, Undo2 } from "lucide-react";
import { Button, Notice } from "../design-system/components";
import { ChangeRow } from "../design-system/patterns";
import { api, onVaultChanged } from "../ipc/api";
import { errorMessage, type Proposal, type Version } from "../ipc/types";
import { useReview } from "../state/review";
import { ReviewModal, proposalWho } from "./ReviewModal";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { ago } from "../time";
import { what, who } from "./history";
import { DesignSystemScope } from "./DesignSystemScope";
import "../design-system/patterns.css";
import "./activityPanel.css";

const noteName = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");
const folder = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const actionLabel = (action: string) => action.charAt(0).toUpperCase() + action.slice(1);
const changeIcon = (action: string) =>
  action === "created" ? FilePlus2 : action === "deleted" ? FileX2 : action === "renamed" ? FolderInput : FilePenLine;
const stamp = (time: number) => (
  <time dateTime={new Date(time).toISOString()} title={new Date(time).toLocaleString()}>
    {ago(time)}
  </time>
);

export function ActivityPanel() {
  const root = useVault((state) => state.vault?.root);
  return <Ledger key={root} root={root} />;
}
function Ledger({ root }: { root?: string }) {
  const pending = useReview((state) => state.pending);
  const initialized = useReview((state) => state.initialized);
  const history = useUi((state) => state.history);
  const [open, setOpen] = useState<Proposal | null>(null);
  const [restore, setRestore] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const historyOpener = useRef<HTMLElement | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const firstReview = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open && restore) {
      (opener.current?.isConnected ? opener.current : (firstReview.current ?? title.current))?.focus({
        preventScroll: true,
      });
      opener.current = null;
      setRestore(false);
    }
  }, [open, restore]);
  useEffect(() => {
    if (!history && historyOpener.current) {
      if (historyOpener.current.isConnected) historyOpener.current.focus({ preventScroll: true });
      historyOpener.current = null;
    }
  }, [history]);
  return (
    <>
      <DesignSystemScope className="workspace-page activity-ledger" role="group" aria-label="Activity and review">
        <header className="activity-heading">
          <h1 ref={title} tabIndex={-1}>
            Activity &amp; review
          </h1>
          <p className="mds-hint">Decide on proposed changes, then browse file history.</p>
        </header>
        {pending.length ? (
          <section className="activity-review-inbox" aria-label="Waiting for your review">
            <h2>
              <Inbox size={17} aria-hidden="true" /> Waiting for your review · {pending.length}
            </h2>
            <div role="list">
              {[...pending]
                .sort((a, b) => a.created - b.created)
                .map((proposal, index) => (
                  <ChangeRow
                    key={proposal.id}
                    name={noteName(proposal.path)}
                    path={folder(proposal.path)}
                    actor={proposalWho(proposal)}
                    action={actionLabel(proposal.action)}
                    time={stamp(proposal.updated)}
                    stale={proposal.stale}
                    icon={<Inbox size={16} aria-hidden="true" />}
                    rowProps={{ role: "listitem" }}
                  >
                    <Button
                      ref={index === 0 ? firstReview : undefined}
                      variant="secondary"
                      onClick={(event) => {
                        if (useVault.getState().vault?.root !== root) return;
                        opener.current = event.currentTarget;
                        setOpen(proposal);
                      }}
                    >
                      <Eye aria-hidden="true" />
                      Review
                    </Button>
                  </ChangeRow>
                ))}
            </div>
          </section>
        ) : (
          <Notice>{initialized ? "No changes waiting for review." : "Loading reviews…"}</Notice>
        )}
        <section aria-label="Applied changes">
          <h2>Applied changes</h2>
          <Activity
            root={root}
            onHistory={(version, button) => {
              historyOpener.current = button;
              useUi.getState().openHistory(version.path, version.action === "renamed" ? undefined : version.id);
            }}
          />
        </section>
      </DesignSystemScope>
      {open && (
        <ReviewModal
          proposal={open}
          onClose={() => {
            setOpen(null);
            setRestore(true);
          }}
        />
      )}
    </>
  );
}
function Activity({ root, onHistory }: { root?: string; onHistory(version: Version, opener: HTMLElement): void }) {
  const [items, setItems] = useState<Version[] | null>(null);
  const [problem, setProblem] = useState<{ id: number; message: string } | null>(null);
  const [undone, setUndone] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<number | null>(null);
  const lock = useRef(false);
  const live = useRef(false);
  const request = useRef(0);
  const undoOpener = useRef<HTMLElement | null>(null);
  const current = () => live.current && !!root && useVault.getState().vault?.root === root;
  const load = useCallback(async () => {
    const generation = ++request.current;
    try {
      const next = await api.aiActivity();
      if (!live.current || useVault.getState().vault?.root !== root || request.current !== generation) return;
      setItems([...next].sort((a, b) => b.time - a.time || b.id - a.id));
      setProblem((previous) => (previous?.id === -1 ? null : previous));
    } catch (cause) {
      if (live.current && useVault.getState().vault?.root === root && request.current === generation)
        setProblem({ id: -1, message: errorMessage(cause) });
    }
  }, [root]);
  useEffect(() => {
    live.current = true;
    void load();
    let off: (() => void) | undefined;
    void onVaultChanged(() => void load()).then((unsubscribe) => {
      if (live.current) off = unsubscribe;
      else unsubscribe();
    });
    return () => {
      live.current = false;
      request.current++;
      off?.();
    };
  }, [load]);
  useEffect(() => {
    if (busy === null && undoOpener.current) {
      if (undoOpener.current.isConnected) {
        const target = (undoOpener.current as HTMLButtonElement).disabled
          ? undoOpener.current
              .closest(".mds-change-row")
              ?.querySelector<HTMLButtonElement>('button[aria-label="File history"]')
          : undoOpener.current;
        target?.focus({ preventScroll: true });
      }
      undoOpener.current = null;
    }
  }, [busy]);
  const undo = async (version: Version, button: HTMLElement) => {
    if (!current() || lock.current || undone.has(version.id)) return;
    lock.current = true;
    undoOpener.current = button;
    setBusy(version.id);
    setProblem(null);
    try {
      await api.undoChange(version.id);
      if (!current()) return;
      setUndone((previous) => new Set(previous).add(version.id));
      await load();
    } catch (cause) {
      if (!current()) return;
      const code = (cause as { code?: string }).code;
      setProblem({
        id: version.id,
        message:
          code === "conflict"
            ? "The file changed again since. Open its history to pick a version."
            : code === "already_exists"
              ? "A file with that name exists again, so it wasn't brought back."
              : errorMessage(cause),
      });
    } finally {
      lock.current = false;
      if (current()) setBusy(null);
    }
  };
  const problemNotice = problem?.id === -1 && (
    <Notice tone="error">
      {problem.message}
      <Button variant="secondary" onClick={() => void load()}>
        Retry activity
      </Button>
    </Notice>
  );
  if (!items) return problemNotice || <Notice>Loading…</Notice>;
  return (
    <>
      {problemNotice}
      {!items.length ? (
        <Notice>
          No changes by AI agents yet. When an agent (or the <code>mosaic</code> command) creates, edits, moves or
          deletes a file, it shows up here, with one-click undo.
        </Notice>
      ) : (
        <div role="list">
          {items.map((version) => {
            const gone = version.action === "deleted",
              Icon = changeIcon(version.action);
            return (
              <ChangeRow
                key={version.id}
                rowProps={{ role: "listitem" }}
                icon={<Icon size={16} aria-hidden="true" />}
                name={
                  <Button
                    className="activity-file"
                    title={version.path}
                    disabled={gone}
                    onClick={() => {
                      if (!current()) return;
                      void useWorkspace
                        .getState()
                        .open(version.path, { newTab: false })
                        .catch((cause) => {
                          if (current()) setProblem({ id: version.id, message: errorMessage(cause) });
                        });
                    }}
                  >
                    {noteName(version.path)}
                  </Button>
                }
                path={folder(version.path)}
                actor={who(version)}
                action={actionLabel(what(version))}
                time={stamp(version.time)}
                notice={problem?.id === version.id && <Notice tone="error">{problem.message}</Notice>}
              >
                <Button
                  aria-label="File history"
                  title="Versions of this file"
                  onClick={(event) => {
                    if (current()) onHistory(version, event.currentTarget);
                  }}
                >
                  <HistoryIcon aria-hidden="true" />
                  History
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy !== null || undone.has(version.id)}
                  title={undone.has(version.id) ? "Undone" : "Undo this change"}
                  onClick={(event) => void undo(version, event.currentTarget)}
                >
                  <Undo2 aria-hidden="true" />
                  {busy === version.id ? "Undoing…" : undone.has(version.id) ? "Undone" : "Undo"}
                </Button>
              </ChangeRow>
            );
          })}
        </div>
      )}
    </>
  );
}
