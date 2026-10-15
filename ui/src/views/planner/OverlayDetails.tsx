import { Lock } from "lucide-react";
import type { CalendarOverlayOccurrence } from "../../ipc/types";

export function OverlayDetails({
  occurrence,
  onImport,
  onClose,
}: {
  occurrence: CalendarOverlayOccurrence;
  onImport(): void;
  onClose(): void;
}) {
  const when = occurrence.all_day
    ? occurrence.start_value
    : `${new Date(occurrence.start_value).toLocaleString()} – ${new Date(occurrence.end_value).toLocaleTimeString()}`;
  return (
    <aside className="planner-editor overlay-details" aria-label="Read-only calendar event">
      <header>
        <div>
          <span>
            <Lock size={13} /> {occurrence.source_name}
          </span>
          <h2>{occurrence.title}</h2>
        </div>
        <button aria-label="Close event details" onClick={onClose}>
          ×
        </button>
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
        <a href={occurrence.meeting_url} target="_blank" rel="noreferrer">
          Open meeting link
        </a>
      )}
      <p className="panel-meta">
        <Lock size={12} /> This event is read-only. Edit it in {occurrence.source_name}.
      </p>
      <button className="primary" onClick={onImport}>
        Copy this occurrence to Mosaic
      </button>
    </aside>
  );
}
