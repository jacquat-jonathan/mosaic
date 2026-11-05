import { useEffect, useRef, useState } from "react";
import { Lock, X } from "lucide-react";
import { Button, IconButton, Notice } from "../../design-system/components";
import { errorMessage, type CalendarOverlayOccurrence } from "../../ipc/types";
import { useVault } from "../../state/vault";
import { DesignSystemScope } from "../DesignSystemScope";
import "./plannerEditor.css";

export function OverlayDetails({
  occurrence,
  onImport,
  onClose,
}: {
  occurrence: CalendarOverlayOccurrence;
  onImport(): Promise<void>;
  onClose(): void;
}) {
  const root = useVault((state) => state.vault?.root),
    live = useRef(true),
    lock = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const current = () => live.current && root === useVault.getState().vault?.root;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const copy = async () => {
    if (lock.current || !current()) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await onImport();
    } catch (reason) {
      if (current()) setError(errorMessage(reason));
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  const when = occurrence.all_day
    ? occurrence.start_value
    : `${new Date(occurrence.start_value).toLocaleString()} – ${new Date(occurrence.end_value).toLocaleTimeString()}`;
  return (
    <DesignSystemScope
      as="aside"
      className="planner-editor overlay-details planner-editor-design"
      aria-label="Read-only calendar event"
      aria-busy={busy}
    >
      <header>
        <div>
          <span className="overlay-source">
            <Lock size={16} /> {occurrence.source_name}
          </span>
          <h2>{occurrence.title}</h2>
        </div>
        <IconButton autoFocus label="Close event details" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <p>{when}</p>
      {occurrence.location && (
        <p>
          <strong>Location</strong>
          <br />
          {occurrence.location}
        </p>
      )}
      {occurrence.description && <p className="overlay-description">{occurrence.description}</p>}
      {occurrence.meeting_url && (
        <a className="mds-button" href={occurrence.meeting_url} target="_blank" rel="noreferrer">
          Open meeting link
        </a>
      )}
      <Notice>
        <Lock size={16} /> This event is read-only. Edit it in {occurrence.source_name}.
      </Notice>
      {error && <Notice tone="error">{error}</Notice>}
      <Button variant="secondary" disabled={busy} onClick={() => void copy()}>
        {busy ? "Copying…" : "Copy this occurrence to Mosaic"}
      </Button>
    </DesignSystemScope>
  );
}
