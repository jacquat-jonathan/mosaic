import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Button, Dialog, Notice, TextField } from "../../design-system/components";
import { api } from "../../ipc/api";
import { errorMessage, type PlannerEpic } from "../../ipc/types";
import { useVault } from "../../state/vault";
import { DesignSystemScope } from "../DesignSystemScope";
import { ActivityTimeline } from "./ActivityTimeline";
import "./epicEditor.css";

export function EpicEditor({
  epic,
  defaultColor,
  onClose,
  onDone,
  returnFocusRef,
}: {
  epic: PlannerEpic | null;
  defaultColor: string;
  onClose(): void;
  onDone(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const root = useVault((state) => state.vault?.root);
  const live = useRef(true),
    lock = useRef(false),
    titleInput = useRef<HTMLInputElement>(null);
  const form = useId();
  const [title, setTitle] = useState(epic?.title ?? ""),
    [color, setColor] = useState(epic?.color ?? defaultColor),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const current = () => live.current && root === useVault.getState().vault?.root;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const save = async () => {
    if (!title.trim() || lock.current || !current()) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      if (epic) await api.updatePlannerEpic(epic.id, { expected_revision: epic.revision, title: title.trim(), color });
      else await api.createPlannerEpic({ title: title.trim(), description: "", color });
      if (current()) onDone();
    } catch (reason) {
      if (current()) setError(errorMessage(reason));
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  return (
    <DesignSystemScope className="epic-editor-scope">
      <Dialog
        open
        title={epic ? "Edit epic" : "New epic"}
        onClose={onClose}
        dismissible={!busy}
        initialFocusRef={titleInput}
        returnFocusRef={returnFocusRef}
        actions={
          <>
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="secondary" type="submit" form={form} disabled={busy || !title.trim()}>
              {busy ? "Saving…" : "Save epic"}
            </Button>
          </>
        }
      >
        <form
          id={form}
          className="epic-editor-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          aria-busy={busy}
        >
          <TextField
            ref={titleInput}
            label="Title"
            value={title}
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Epic title"
          />
          <TextField
            label="Color"
            type="color"
            value={color}
            disabled={busy}
            onChange={(event) => setColor(event.target.value)}
          />
          {error && <Notice tone="error">{error}</Notice>}
        </form>
      </Dialog>
    </DesignSystemScope>
  );
}

export function EpicHistoryDialog({
  epic,
  onClose,
  returnFocusRef,
}: {
  epic: PlannerEpic;
  onClose(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <DesignSystemScope className="epic-editor-scope">
      <Dialog
        open
        title={`${epic.title} history`}
        onClose={onClose}
        returnFocusRef={returnFocusRef}
        actions={
          <Button variant="secondary" aria-label="Close epic history" onClick={onClose}>
            Close
          </Button>
        }
      >
        <ActivityTimeline kind="epic" id={epic.id} revision={epic.revision} defaultOpen designSystem />
      </Dialog>
    </DesignSystemScope>
  );
}
