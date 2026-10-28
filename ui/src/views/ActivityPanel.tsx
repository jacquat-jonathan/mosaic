// AI activity: changes waiting for review (folders under review), then every change AI agents and the
// command line made to the vault, newest first, each with a one-click undo (built on the file history,
// see crates/mosaic-core/src/history.rs and review.rs).

import { useCallback, useEffect, useState } from "react";
import { Eye, FilePenLine, FilePlus2, FileX2, FolderInput, History as HistoryIcon, Inbox, Undo2 } from "lucide-react";
import { api, onVaultChanged } from "../ipc/api";
import { errorMessage, type Proposal, type Version } from "../ipc/types";
import { useReview } from "../state/review";
import { ReviewModal, proposalWho } from "./ReviewModal";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { ago } from "../time";
import { what, who } from "./history";

const noteName = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");
const folder = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null);
const actionLabel = (action: string) => action.charAt(0).toUpperCase() + action.slice(1);
const changeIcon = (action: string) =>
  action === "created" ? FilePlus2 : action === "deleted" ? FileX2 : action === "renamed" ? FolderInput : FilePenLine;

/** Agents' changes waiting for the person's decision, oldest first. */
function ReviewInbox() {
  const pending = useReview((s) => s.pending);
  const [open, setOpen] = useState<Proposal | null>(null);
  if (!pending.length) return null;
  return (
    <section className="review-inbox" aria-label="Waiting for your review">
      <h2>
        <Inbox size={16} aria-hidden="true" /> Waiting for your review · {pending.length}
      </h2>
      <div role="list">
        {[...pending]
          .sort((a, b) => a.created - b.created)
          .map((p) => (
            <div key={p.id} className="activity-item review-item" role="listitem">
              <div className="activity-main">
                <div className="activity-name" title={p.path}>
                  {noteName(p.path)}
                </div>
                <div className="activity-meta">
                  <span>{proposalWho(p)}</span>
                  <span>{actionLabel(p.action)}</span>
                  <time dateTime={new Date(p.updated).toISOString()} title={new Date(p.updated).toLocaleString()}>
                    {ago(p.updated)}
                  </time>
                </div>
                {folder(p.path) && <div className="activity-folder">{folder(p.path)}</div>}
                {p.stale && (
                  <span className="review-stale" title="The file changed since the agent proposed this">
                    File changed since proposal
                  </span>
                )}
              </div>
              <div className="activity-actions">
                <button className="primary" onClick={() => setOpen(p)}>
                  <Eye size={13} /> Review
                </button>
              </div>
            </div>
          ))}
      </div>
      {open && <ReviewModal proposal={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

export function ActivityPanel() {
  return (
    <div className="activity-ledger">
      <ReviewInbox />
      <section aria-label="Applied changes">
        <h2>Applied changes</h2>
        <Activity />
      </section>
    </div>
  );
}

function Activity() {
  const [items, setItems] = useState<Version[] | null>(null);
  const [problem, setProblem] = useState<{ id: number; message: string } | null>(null);
  const [undone, setUndone] = useState<Set<number>>(new Set());

  const load = useCallback(() => {
    api.aiActivity().then(
      (items) => {
        setItems([...items].sort((a, b) => b.time - a.time || b.id - a.id));
        setProblem((previous) => (previous?.id === -1 ? null : previous));
      },
      (e) => setProblem({ id: -1, message: errorMessage(e) }),
    );
  }, []);

  useEffect(() => {
    load();
    let off: (() => void) | undefined;
    void onVaultChanged(() => load()).then((f) => (off = f));
    return () => off?.();
  }, [load]);

  const undo = async (v: Version) => {
    setProblem(null);
    try {
      await api.undoChange(v.id);
      setUndone((s) => new Set(s).add(v.id));
      load();
    } catch (e) {
      const message =
        (e as { code?: string }).code === "conflict"
          ? "The file changed again since. Open its history to pick a version."
          : (e as { code?: string }).code === "already_exists"
            ? "A file with that name exists again, so it wasn't brought back."
            : errorMessage(e);
      setProblem({ id: v.id, message });
    }
  };

  if (!items)
    return problem ? (
      <p className="error-text" role="alert">
        {problem.message}
      </p>
    ) : (
      <div className="panel-meta">Loading…</div>
    );
  if (!items.length) {
    return (
      <div className="activity-empty panel-meta">
        No changes by AI agents yet. When an agent (or the <code>mosaic</code> command) creates, edits, moves or deletes
        a file, it shows up here, with one-click undo.
      </div>
    );
  }
  return (
    <div className="activity" role="list">
      {items.map((v) => {
        const gone = v.action === "deleted";
        const Icon = changeIcon(v.action);
        return (
          <div key={v.id} role="listitem" className="activity-item">
            <Icon className="activity-icon" size={16} aria-hidden="true" />
            <div className="activity-main">
              <button
                className="activity-path"
                title={v.path}
                disabled={gone}
                onClick={() => void useWorkspace.getState().open(v.path, { newTab: false })}
              >
                {noteName(v.path)}
              </button>
              <div className="activity-meta">
                <span>{who(v)}</span>
                <span>{actionLabel(what(v))}</span>
                <time dateTime={new Date(v.time).toISOString()} title={new Date(v.time).toLocaleString()}>
                  {ago(v.time)}
                </time>
              </div>
              {folder(v.path) && <div className="activity-folder">{folder(v.path)}</div>}
            </div>
            <div className="activity-actions">
              <button
                title="Versions of this file"
                aria-label="File history"
                onClick={() => useUi.getState().openHistory(v.path, v.action === "renamed" ? undefined : v.id)}
              >
                <HistoryIcon size={13} /> History
              </button>
              <button
                className="activity-undo"
                title={undone.has(v.id) ? "Undone" : "Undo this change"}
                disabled={undone.has(v.id)}
                onClick={() => void undo(v)}
              >
                <Undo2 size={13} /> {undone.has(v.id) ? "Undone" : "Undo"}
              </button>
            </div>
            {problem?.id === v.id && (
              <p className="error-text" role="alert">
                {problem.message}
              </p>
            )}
          </div>
        );
      })}
      {problem?.id === -1 && (
        <p className="error-text" role="alert">
          {problem.message}
        </p>
      )}
    </div>
  );
}
