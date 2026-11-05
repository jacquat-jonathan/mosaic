import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, X } from "lucide-react";
import { Button, Dialog, Notice, SegmentedControl, TextArea } from "../design-system/components";
import { DiffView } from "../design-system/patterns";
import { api } from "../ipc/api";
import { errorMessage, type Proposal } from "../ipc/types";
import { acceptHunks, diffLines, reviewHunks } from "../diff";
import { useReview } from "../state/review";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { ago } from "../time";
import { DesignSystemScope } from "./DesignSystemScope";
import "../design-system/patterns.css";
import "./reviewModal.css";

export const proposalWho = (proposal: Proposal) =>
  proposal.actor ?? (proposal.source === "cli" ? "mosaic command" : "an agent");
export function proposalWhat(proposal: Proposal): string {
  return proposal.action === "created"
    ? "wants to create"
    : proposal.action === "deleted"
      ? "wants to delete"
      : proposal.action === "renamed"
        ? "wants to rename"
        : "wants to change";
}
type Props = { proposal: Proposal; onClose(): void; returnFocusRef?: RefObject<HTMLElement | null> };
export function ReviewModal(props: Props) {
  const root = useVault((state) => state.vault?.root);
  return <Review key={`${root}:${props.proposal.id}`} {...props} root={root} />;
}
function Review({ proposal, onClose, returnFocusRef, root }: Props & { root?: string }) {
  const [proposed, setProposed] = useState<string | null | undefined>();
  const [current, setCurrent] = useState<string | null | undefined>();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [conflict, setConflict] = useState(proposal.stale ?? false);
  const [base, setBase] = useState<string | null | undefined>();
  const [showYours, setShowYours] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadTick, setLoadTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<"accepted" | "rejected" | null>(null);
  const [selectedHunks, setSelectedHunks] = useState<Set<number>>(new Set());
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const rejectButton = useRef<HTMLButtonElement>(null);
  const lock = useRef(false);
  const mounted = useRef(true);
  const currentVault = () => mounted.current && !!root && useVault.getState().vault?.root === root;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    setError(null);
    setLoadError(false);
    setProposed(undefined);
    setCurrent(undefined);
    void Promise.all([
      api.proposalContent(proposal.id),
      api
        .read(proposal.path)
        .then((file) => file.content ?? "")
        .catch((cause) => {
          if ((cause as { code?: string }).code === "not_found") return null;
          throw cause;
        }),
    ]).then(
      ([next, existing]) => {
        if (live) {
          setProposed(next);
          setCurrent(existing);
        }
      },
      (cause) => {
        if (live) {
          setError(errorMessage(cause));
          setLoadError(true);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [proposal.id, proposal.path, loadTick]);
  useEffect(() => {
    if (!conflict || base !== undefined) return;
    let live = true;
    void api.proposalBase(proposal.id).then(
      (value) => {
        if (live) setBase(value);
      },
      () => {
        if (live) setBase(null);
      },
    );
    return () => {
      live = false;
    };
  }, [conflict, base, proposal.id]);
  useEffect(() => {
    if (rejecting) reasonField.current?.focus();
  }, [rejecting]);
  const lines = useMemo(() => {
    if (proposed === undefined || current === undefined) return null;
    if (current === null) return (proposed ?? "").split("\n").map((text) => ({ op: "add" as const, text }));
    if (proposed === null) return current.split("\n").map((text) => ({ op: "del" as const, text }));
    return diffLines(current, proposed);
  }, [proposed, current]);
  const selectable =
    proposal.action === "edited" && !proposal.binary && typeof proposed === "string" && typeof current === "string";
  const reviewLines = useMemo(
    () => (selectable ? reviewHunks(current!, proposed!) : null),
    [selectable, current, proposed],
  );
  const hunkCount = useMemo(
    () => (reviewLines ? Math.max(-1, ...reviewLines.map((line) => line.hunk ?? -1)) + 1 : 0),
    [reviewLines],
  );
  useEffect(() => {
    setSelectedHunks(new Set(Array.from({ length: hunkCount }, (_, index) => index)));
  }, [hunkCount]);
  const yours = useMemo(
    () => (typeof base === "string" && typeof current === "string" ? diffLines(base, current) : null),
    [base, current],
  );
  const shown = useMemo(
    () =>
      (showYours && yours ? yours : (reviewLines ?? lines))?.map((line) => ({
        ...line,
        hunk: (line as { hunk?: number | null }).hunk ?? null,
      })) ?? null,
    [showYours, yours, reviewLines, lines],
  );
  const accept = async () => {
    if (!currentVault() || lock.current || decision || !lines || (selectable && selectedHunks.size === 0)) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    let applied = false;
    try {
      const partial =
        selectable && selectedHunks.size < hunkCount ? acceptHunks(current!, proposed!, selectedHunks) : null;
      const path = await api.acceptProposal(proposal.id, conflict, partial);
      if (!currentVault()) return;
      applied = true;
      setDecision("accepted");
      await useReview.getState().refresh();
      if (!currentVault()) return;
      if (proposal.action !== "deleted") await useWorkspace.getState().open(path, { newTab: false });
      if (currentVault()) onClose();
    } catch (cause) {
      if (!currentVault()) return;
      if (applied) setError(`The change was accepted, but the file could not be opened: ${errorMessage(cause)}`);
      else if ((cause as { code?: string }).code === "conflict") {
        setConflict(true);
        setBase(undefined);
        setLoadTick((tick) => tick + 1);
      } else setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (currentVault()) setBusy(false);
    }
  };
  const reject = async () => {
    if (!currentVault() || lock.current || decision) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.rejectProposal(proposal.id, reason.trim() || null);
      if (!currentVault()) return;
      setDecision("rejected");
      await useReview.getState().refresh();
      if (currentVault()) onClose();
    } catch (cause) {
      if (currentVault()) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (currentVault()) setBusy(false);
    }
  };
  const name = proposal.path.split("/").pop()!.replace(/\.md$/, "");
  return (
    <DesignSystemScope className="review-dialog-scope">
      <Dialog
        open
        size="wide"
        title={`Review the change to ${name}`}
        description={`${proposal.path} · proposed ${ago(proposal.updated)}`}
        onClose={onClose}
        returnFocusRef={returnFocusRef}
        dismissible={!busy}
        actions={
          decision ? (
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Close
            </Button>
          ) : rejecting ? (
            <>
              <Button
                disabled={busy}
                onClick={() => {
                  setRejecting(false);
                  requestAnimationFrame(() => rejectButton.current?.focus());
                }}
              >
                Back
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => void reject()}>
                <X aria-hidden="true" />
                {busy ? "Rejecting…" : "Reject"}
              </Button>
            </>
          ) : (
            <>
              <Button ref={rejectButton} disabled={busy} onClick={() => setRejecting(true)}>
                <X aria-hidden="true" />
                Reject…
              </Button>
              <Button
                variant="secondary"
                disabled={busy || lines === null || (selectable && selectedHunks.size === 0)}
                onClick={() => void accept()}
              >
                <Check aria-hidden="true" />
                {busy
                  ? "Accepting…"
                  : conflict
                    ? "Accept anyway"
                    : selectable && selectedHunks.size < hunkCount
                      ? `Accept ${selectedHunks.size} of ${hunkCount}`
                      : "Accept"}
              </Button>
            </>
          )
        }
      >
        <p>
          {proposalWho(proposal)} {proposalWhat(proposal)} “{name}”.{" "}
          {proposal.action === "renamed"
            ? `Accepting renames it to ${proposal.to_path}.`
            : proposal.binary
              ? proposal.action === "deleted"
                ? "Accepting moves this binary file to the Trash."
                : "Accepting adds this binary file."
              : proposal.action === "deleted"
                ? "Accepting moves the file to the Trash."
                : proposal.action === "created"
                  ? "Accepting creates the file."
                  : "Red lines go, green lines come."}{" "}
          {proposal.binary
            ? "Binary changes are applied after your review."
            : "Accepted changes show in AI activity, with Undo."}
        </p>
        {conflict && (
          <Notice tone="warning" role="alert">
            <strong>The file changed after the agent proposed this.</strong>{" "}
            {proposal.action === "deleted"
              ? "Accepting deletes it, with those changes."
              : "Accepting replaces those changes with the agent's version."}{" "}
            They stay in the file's history.
            {yours && (
              <SegmentedControl
                label="Which change to show"
                value={showYours ? "yours" : "accepting"}
                options={[
                  { value: "accepting", label: "What accepting does" },
                  { value: "yours", label: "What changed since" },
                ]}
                onChange={(value) => setShowYours(value === "yours")}
                disabled={busy}
              />
            )}
          </Notice>
        )}
        {proposal.binary ? (
          <Notice>Binary files do not have a text diff.</Notice>
        ) : proposal.action === "renamed" ? (
          <p>
            <code>{proposal.path}</code> → <code>{proposal.to_path}</code>
            {proposal.update_links ? "; links will follow." : "."}
          </p>
        ) : shown ? (
          <DiffView
            label={showYours ? "Changes since proposal" : "Proposed changes"}
            lines={shown.map((line, index) => ({
              type: line.op === "add" ? "add" : line.op === "del" ? "remove" : "context",
              text: line.text || " ",
              control:
                !showYours && line.hunk !== null && (index === 0 || shown[index - 1].hunk !== line.hunk) ? (
                  <input
                    className="review-hunk"
                    type="checkbox"
                    checked={selectedHunks.has(line.hunk)}
                    disabled={busy || !!decision}
                    aria-label={`Accept change ${line.hunk + 1}`}
                    onChange={(event) =>
                      setSelectedHunks((previous) => {
                        const next = new Set(previous);
                        if (event.target.checked) next.add(line.hunk!);
                        else next.delete(line.hunk!);
                        return next;
                      })
                    }
                  />
                ) : undefined,
            }))}
          />
        ) : (
          !loadError && <Notice>Loading comparison…</Notice>
        )}
        {rejecting && (
          <TextArea
            ref={reasonField}
            label="Tell the agent why (optional; it sees this when it checks its proposals)"
            value={reason}
            rows={2}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. keep the old wording"
            disabled={busy || !!decision}
          />
        )}
        {error && (
          <Notice tone="error">
            {error}
            {loadError && (
              <Button variant="secondary" onClick={() => setLoadTick((tick) => tick + 1)}>
                Retry comparison
              </Button>
            )}
          </Notice>
        )}
      </Dialog>
    </DesignSystemScope>
  );
}
