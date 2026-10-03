// Reviewing one agent proposal: the change as a diff against the file as it is now, then accept
// (applied and logged as the agent's change, so it can still be undone) or reject with a reason the
// agent can read.

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { api } from "../ipc/api";
import { errorMessage, type Proposal } from "../ipc/types";
import { diffLines } from "../diff";
import { useReview } from "../state/review";
import { useWorkspace } from "../state/workspace";
import { ago } from "../time";

export const proposalWho = (p: Proposal) => p.actor ?? (p.source === "cli" ? "mosaic command" : "an agent");

export function proposalWhat(p: Proposal): string {
  return p.action === "created" ? "wants to create" : p.action === "deleted" ? "wants to delete" : "wants to change";
}

export function ReviewModal({ proposal, onClose }: { proposal: Proposal; onClose(): void }) {
  const [proposed, setProposed] = useState<string | null | undefined>(undefined);
  const [current, setCurrent] = useState<string | null | undefined>(undefined);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [conflict, setConflict] = useState(proposal.stale);
  // The file as the agent saw it, to show what the person changed since (on a conflict).
  const [base, setBase] = useState<string | null | undefined>(undefined);
  const [showYours, setShowYours] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.proposalContent(proposal.id).then(setProposed, (e) => setError(errorMessage(e)));
    api.read(proposal.path).then(
      (f) => setCurrent(f.content ?? ""),
      () => setCurrent(null),
    );
  }, [proposal.id, proposal.path]);

  useEffect(() => {
    if (conflict && base === undefined) api.proposalBase(proposal.id).then(setBase, () => setBase(null));
  }, [conflict, base, proposal.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const lines = useMemo(() => {
    if (proposed === undefined || current === undefined) return null;
    // A new file is all added lines, a deletion all removed ones (no empty "other side" line).
    if (current === null) return (proposed ?? "").split("\n").map((text) => ({ op: "add" as const, text }));
    if (proposed === null) return current.split("\n").map((text) => ({ op: "del" as const, text }));
    return diffLines(current, proposed);
  }, [proposed, current]);
  // What the person changed since the proposal: the file then → the file now.
  const yours = useMemo(() => (typeof base === "string" && typeof current === "string" ? diffLines(base, current) : null), [base, current]);
  const shown = showYours && yours ? yours : lines;

  const done = () => {
    void useReview.getState().refresh();
    onClose();
  };
  const accept = async (force: boolean) => {
    setError(null);
    try {
      const path = await api.acceptProposal(proposal.id, force);
      done();
      if (proposal.action !== "deleted") void useWorkspace.getState().open(path, { newTab: false });
    } catch (e) {
      if ((e as { code?: string }).code === "conflict") setConflict(true);
      else setError(errorMessage(e));
    }
  };
  const reject = async () => {
    setError(null);
    try {
      await api.rejectProposal(proposal.id, reason.trim() || null);
      done();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const name = proposal.path.split("/").pop()!.replace(/\.md$/, "");
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal history review" role="dialog" aria-label={`Review the change to ${name}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="history-head">
          <h2>
            {proposalWho(proposal)} {proposalWhat(proposal)} “{name}”
          </h2>
          <button className="icon" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="settings-note">
          <code>{proposal.path}</code> · proposed {ago(proposal.updated)}.{" "}
          {proposal.action === "deleted"
            ? "Accepting moves the file to the Trash."
            : proposal.action === "created"
              ? "Accepting creates the file."
              : "Red lines go, green lines come."}{" "}
          Accepted changes show in AI activity, with Undo.
        </p>
        {conflict && (
          <div className="review-conflict" role="alert">
            <AlertTriangle size={16} />
            <div>
              <strong>The file changed after the agent proposed this.</strong>{" "}
              {proposal.action === "deleted"
                ? "Accepting deletes it, with those changes."
                : "Accepting replaces those changes with the agent's version."}{" "}
              They stay in the file's history.
              {yours && (
                <div className="review-toggle" role="group" aria-label="Which change to show">
                  <button className={showYours ? "" : "on"} onClick={() => setShowYours(false)}>
                    What accepting does
                  </button>
                  <button className={showYours ? "on" : ""} onClick={() => setShowYours(true)}>
                    What changed since
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        <div className="history-diff">
          {shown && (
            <pre className="diff">
              {shown.map((l, i) => (
                <div key={i} className={`diff-${l.op}`}>
                  <span className="diff-sign">{l.op === "add" ? "+" : l.op === "del" ? "−" : " "}</span>
                  {l.text || " "}
                </div>
              ))}
            </pre>
          )}
        </div>
        {rejecting && (
          <label className="review-reason">
            Tell the agent why (optional; it sees this when it checks its proposals)
            <textarea autoFocus value={reason} rows={2} onChange={(e) => setReason(e.target.value)} placeholder="e.g. keep the old wording" />
          </label>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          {rejecting ? (
            <>
              <button onClick={() => setRejecting(false)}>Back</button>
              <button className="primary danger" onClick={() => void reject()}>
                <X size={14} /> Reject
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setRejecting(true)}>
                <X size={14} /> Reject…
              </button>
              <button className={conflict ? "primary danger" : "primary"} disabled={lines === null} onClick={() => void accept(conflict)}>
                <Check size={14} /> {conflict ? "Accept anyway" : "Accept"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
