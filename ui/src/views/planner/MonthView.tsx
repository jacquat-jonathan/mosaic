import { useEffect, useState, type CSSProperties, type MouseEvent } from "react";
import type {
  CalendarOverlayOccurrence,
  CalendarWorkSession,
  EventOccurrence,
  PlannerCalendarRange,
  PlannerWorkSession,
} from "../../ipc/types";
import { EVENT_DRAG, SESSION_DRAG, isoDay, localDate } from "./calendarModel";

type MonthEntry =
  | { kind: "event"; key: string; label: string; color: string; event: EventOccurrence }
  | { kind: "overlay"; key: string; label: string; color: string; overlay: CalendarOverlayOccurrence }
  | { kind: "session"; key: string; label: string; color: string; session: CalendarWorkSession };
type ContextTarget =
  | { kind: "event"; event: EventOccurrence; x: number; y: number }
  | { kind: "session"; session: PlannerWorkSession; x: number; y: number };
type ContextItem = { kind: "event"; event: EventOccurrence } | { kind: "session"; session: PlannerWorkSession };
type DragPreview = { day: string; targetDay: string; label: string; color: string } | null;

export function MonthView({
  days,
  anchor,
  data,
  overlays,
  today,
  show,
  onDay,
  onEvent,
  onSession,
  onOverlay,
  onEventMove,
  onSessionMove,
  onEventDelete,
  onSessionDelete,
}: {
  days: Date[];
  anchor: Date;
  data: PlannerCalendarRange;
  overlays: CalendarOverlayOccurrence[];
  today: string;
  show: { events: boolean; sessions: boolean; due: boolean };
  onDay(day: string): void;
  onEvent(id: string, key: string): void;
  onSession(session: PlannerWorkSession): void;
  onOverlay(item: CalendarOverlayOccurrence): void;
  onEventMove(event: EventOccurrence, day: string): void;
  onSessionMove(session: PlannerWorkSession, day: string): void;
  onEventDelete(event: EventOccurrence): void;
  onSessionDelete(session: PlannerWorkSession): void;
}) {
  const [dragPreview, setDragPreview] = useState<DragPreview>(null),
    [contextTarget, setContextTarget] = useState<ContextTarget | null>(null);
  useEffect(() => {
    if (!contextTarget) return;
    const close = () => setContextTarget(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [contextTarget]);
  const weekdays = days.slice(0, 5).map((day) => day.toLocaleDateString(undefined, { weekday: "short" }));
  const openMenu = (event: MouseEvent, target: ContextItem) => {
    event.preventDefault();
    event.stopPropagation();
    setContextTarget({ ...target, x: event.clientX, y: event.clientY });
  };
  return (
    <div className="planner-month" role="grid">
      {weekdays.map((weekday, index) => (
        <div className="planner-month-weekday" role="columnheader" key={`${weekday}:${index}`}>
          {weekday}
        </div>
      ))}
      {days.map((date) => {
        const day = isoDay(date),
          events = show.events
            ? data.events.filter((item) =>
                item.all_day
                  ? item.start_value <= day && item.end_value > day
                  : localDate(item.start_value, item.timezone) === day,
              )
            : [],
          external = overlays.filter((item) =>
            item.all_day
              ? item.start_value <= day && item.end_value > day
              : localDate(item.start_value, item.timezone) === day,
          ),
          sessions = show.sessions
            ? data.work_sessions.filter((item) =>
                item.session.all_day
                  ? item.session.start_value <= day && item.session.end_value > day
                  : localDate(item.session.start_value, item.session.timezone) === day,
              )
            : [],
          due = show.due ? data.due_markers.filter((item) => item.date === day) : [],
          work = data.workload.find((item) => item.date === day)?.minutes ?? 0;
        const entries: MonthEntry[] = [
          ...events.map((event) => ({
            kind: "event" as const,
            key: `event:${event.series_id}:${event.occurrence_key}`,
            label: event.title,
            color: event.color ?? "var(--accent)",
            event,
          })),
          ...external.map((overlay) => ({
            kind: "overlay" as const,
            key: `overlay:${overlay.source_id}:${overlay.uid}:${overlay.occurrence_key}`,
            label: overlay.title,
            color: overlay.color ?? "var(--muted)",
            overlay,
          })),
          ...sessions.map((session) => ({
            kind: "session" as const,
            key: `session:${session.session.id}`,
            label: `◷ ${session.task_title}`,
            color: session.color ?? "var(--accent)",
            session,
          })),
        ];
        return (
          <div
            role="gridcell"
            tabIndex={0}
            aria-label={date.toLocaleDateString()}
            className={`planner-month-cell ${date.getMonth() !== anchor.getMonth() ? "other-month" : ""} ${day === today ? "today" : ""} ${dragPreview?.targetDay === day ? "drop-target" : ""}`}
            key={day}
            onClick={() => onDay(day)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onDay(day);
              }
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragPreview((current) => (current ? { ...current, targetDay: day } : current));
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setDragPreview(null);
              const eventKey = event.dataTransfer.getData(EVENT_DRAG),
                sessionId = event.dataTransfer.getData(SESSION_DRAG);
              if (eventKey) {
                try {
                  const key = JSON.parse(eventKey) as { seriesId: string; occurrenceKey: string };
                  const occurrence = data.events.find(
                    (item) => item.series_id === key.seriesId && item.occurrence_key === key.occurrenceKey,
                  );
                  if (occurrence) onEventMove(occurrence, day);
                } catch {
                  /* Ignore invalid external drag data. */
                }
              } else if (sessionId) {
                const session = data.work_sessions.find((item) => item.session.id === sessionId)?.session;
                if (session) onSessionMove(session, day);
              }
            }}
          >
            <span className="planner-month-date">{date.getDate()}</span>
            {work > 0 && (
              <span className="planner-workload" title={`${work} planned minutes`}>
                {Math.round((work / 60) * 10) / 10}h
              </span>
            )}
            {due.map((marker) => (
              <span
                className="planner-due"
                key={marker.task_id}
                style={{ borderColor: marker.color ?? "var(--danger)" }}
              >
                ◆ {marker.title}
              </span>
            ))}
            {dragPreview?.targetDay === day && dragPreview.day !== day && (
              <span
                className="planner-month-drop-preview"
                style={{ "--preview-color": dragPreview.color } as CSSProperties}
              >
                ↳ {dragPreview.label}
              </span>
            )}
            {entries.slice(0, 3).map((entry) =>
              entry.kind === "event" ? (
                <button
                  className="planner-month-item event-card"
                  draggable
                  style={{ borderColor: entry.color }}
                  key={entry.key}
                  onDragStart={(drag) => {
                    drag.stopPropagation();
                    drag.dataTransfer.setData(
                      EVENT_DRAG,
                      JSON.stringify({ seriesId: entry.event.series_id, occurrenceKey: entry.event.occurrence_key }),
                    );
                    drag.dataTransfer.effectAllowed = "move";
                    setDragPreview({ day, targetDay: day, label: entry.label, color: entry.color });
                  }}
                  onDragEnd={() => setDragPreview(null)}
                  onContextMenu={(event) => openMenu(event, { kind: "event", event: entry.event })}
                  onClick={(click) => {
                    click.stopPropagation();
                    onEvent(entry.event.series_id, entry.event.occurrence_key);
                  }}
                >
                  {entry.label}
                </button>
              ) : entry.kind === "overlay" ? (
                <button
                  className="planner-month-item read-only event-card"
                  style={{ borderColor: entry.color }}
                  key={entry.key}
                  onClick={(click) => {
                    click.stopPropagation();
                    onOverlay(entry.overlay);
                  }}
                >
                  {entry.label}
                </button>
              ) : (
                <span
                  className="planner-month-item"
                  role="button"
                  tabIndex={0}
                  draggable
                  style={{ borderColor: entry.color }}
                  key={entry.key}
                  onDragStart={(drag) => {
                    drag.stopPropagation();
                    drag.dataTransfer.setData(SESSION_DRAG, entry.session.session.id);
                    drag.dataTransfer.effectAllowed = "move";
                    setDragPreview({ day, targetDay: day, label: entry.label, color: entry.color });
                  }}
                  onDragEnd={() => setDragPreview(null)}
                  onContextMenu={(event) => openMenu(event, { kind: "session", session: entry.session.session })}
                  onClick={(click) => {
                    click.stopPropagation();
                    onSession(entry.session.session);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      onSession(entry.session.session);
                    }
                  }}
                >
                  {entry.label}
                </span>
              ),
            )}
            {entries.length > 3 && <span className="calendar-more">+{entries.length - 3} more</span>}
          </div>
        );
      })}
      {contextTarget && (
        <div
          className="planner-session-menu"
          role="menu"
          style={{ left: contextTarget.x, top: contextTarget.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            role="menuitem"
            onClick={() => {
              if (contextTarget.kind === "event") onEventDelete(contextTarget.event);
              else onSessionDelete(contextTarget.session);
              setContextTarget(null);
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
