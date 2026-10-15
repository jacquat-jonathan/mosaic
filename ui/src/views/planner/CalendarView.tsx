import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, RefreshCw, Upload } from "lucide-react";
import { api, inTauri, onPlannerChanged } from "../../ipc/api";
import {
  errorMessage,
  type CalendarOverlayOccurrence,
  type CalendarOverlayRange,
  type CreatePlannerEvent,
  type EventOccurrence,
  type IcalImportPreview,
  type PlannerCalendarRange,
  type PlannerEpic,
  type PlannerEvent,
  type PlannerTask,
  type PlannerWorkSession,
} from "../../ipc/types";
import { useSettings } from "../../state/settings";
import { useVault } from "../../state/vault";
import { Segmented, Toolbar } from "../../viewers/Toolbar";
import { EventEditor } from "./EventEditor";
import { EventArchiveDialog } from "./EventArchiveDialog";
import { CalendarSourcesDialog } from "./CalendarSourcesDialog";
import { IcalImportWizard } from "./IcalImportWizard";
import { MonthView } from "./MonthView";
import { OverlayDetails } from "./OverlayDetails";
import { UnscheduledTray } from "./UnscheduledTray";
import { WeekView } from "./WeekView";
import { addDays, atNoon, isoDay, localHour, type CalendarMode, visibleDays } from "./calendarModel";

const MODE_KEY = "mosaic:planner-calendar-mode";
function storedMode(): CalendarMode {
  try {
    const value = localStorage.getItem(MODE_KEY);
    return value === "month" || value === "day" ? value : "week";
  } catch {
    return "week";
  }
}
const emptyRange = (from: string, to: string): PlannerCalendarRange => ({
  from,
  to,
  events: [],
  work_sessions: [],
  due_markers: [],
  unscheduled_tasks: [],
  workload: [],
});
const emptyOverlay: CalendarOverlayRange = { subscriptions: [], occurrences: [] };
type EditorState = {
  occurrence: EventOccurrence | null;
  series: PlannerEvent | null;
  initialStart?: string;
  initialEnd?: string;
  initialAllDay?: boolean;
};
type SelectedRange = { day: string; startHour: number; endHour: number };
const localInstant = (day: string, hour: number) => {
  const whole = Math.floor(hour),
    minutes = Math.round((hour - whole) * 60);
  return new Date(`${day}T${String(whole).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`).toISOString();
};
const plusIsoDays = (day: string, count: number) => isoDay(addDays(new Date(`${day}T12:00:00`), count));

export function CalendarView({ initialMode }: { initialMode?: CalendarMode }) {
  const root = useVault((state) => state.vault?.root) ?? "",
    sunday = useSettings((state) => state.weekStart === "sunday");
  const [mode, setModeState] = useState<CalendarMode>(initialMode ?? storedMode),
    [anchor, setAnchor] = useState(() => atNoon(new Date())),
    [data, setData] = useState<PlannerCalendarRange | null>(null),
    [overlay, setOverlay] = useState<CalendarOverlayRange>(emptyOverlay),
    [epics, setEpics] = useState<PlannerEpic[]>([]),
    [events, setEvents] = useState<PlannerEvent[]>([]),
    [editor, setEditor] = useState<EditorState | null>(null),
    [selectedRange, setSelectedRange] = useState<SelectedRange | null>(null),
    [overlayDetails, setOverlayDetails] = useState<CalendarOverlayOccurrence | null>(null),
    [importing, setImporting] = useState<{ preview: IcalImportPreview; fileName: string } | null>(null),
    [sourcesOpen, setSourcesOpen] = useState(false),
    [archivesOpen, setArchivesOpen] = useState(false),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [show, setShow] = useState({ events: true, sessions: true, due: true });
  const importInput = useRef<HTMLInputElement>(null);
  const days = useMemo(() => visibleDays(anchor, mode, sunday), [anchor, mode, sunday]),
    from = isoDay(days[0]),
    to = isoDay(days.at(-1)!);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const load = useCallback(async () => {
    if (!root) return;
    setLoading(true);
    try {
      const [range, nextOverlay, nextEpics, nextEvents] = await Promise.all([
        api.plannerCalendarRange(from, to),
        api.calendarOverlayRange(from, to, timezone),
        api.plannerEpics(false, false),
        api.plannerEvents(false, false),
      ]);
      if (useVault.getState().vault?.root !== root) return;
      setData(range);
      setOverlay(nextOverlay);
      setEpics(nextEpics);
      setEvents(nextEvents);
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason));
      setData(emptyRange(from, to));
      setOverlay(emptyOverlay);
    } finally {
      setLoading(false);
    }
  }, [root, from, to, timezone]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    let off: (() => void) | undefined;
    void onPlannerChanged((change) => {
      if (change.root === root) void load();
    }).then((value) => {
      off = value;
    });
    return () => off?.();
  }, [root, load]);
  const refreshSubscriptions = useCallback(
    async (force = false) => {
      try {
        await api.refreshCalendarSubscriptions(force);
        await load();
      } catch (reason) {
        setError(errorMessage(reason));
      }
    },
    [load],
  );
  useEffect(() => {
    if (!root) return;
    void refreshSubscriptions(false);
    const timer = window.setInterval(() => void refreshSubscriptions(false), 300000);
    const focus = () => void refreshSubscriptions(false);
    window.addEventListener("focus", focus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [root, refreshSubscriptions]);
  const setMode = (next: CalendarMode) => {
    setSelectedRange(null);
    setModeState(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* convenience only */
    }
  };
  const step = (amount: number) =>
    setAnchor((current) =>
      mode === "month"
        ? new Date(current.getFullYear(), current.getMonth() + amount, 1, 12)
        : addDays(current, amount * (mode === "week" ? 7 : 1)),
    );
  const title =
    mode === "month"
      ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : mode === "day"
        ? anchor.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
        : `${days[0].toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${days.at(-1)!.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
  const openEvent = (seriesId: string, key: string) => {
    setSelectedRange(null);
    const occurrence = data?.events.find((item) => item.series_id === seriesId && item.occurrence_key === key) ?? null,
      series = events.find((item) => item.id === seriesId) ?? null;
    setEditor({ occurrence, series });
  };
  const newEvent = (day = isoDay(anchor), startHour = 9, endHour = 10, allDay = false) =>
    setEditor({
      occurrence: null,
      series: null,
      initialStart: allDay ? day : localInstant(day, startHour),
      initialEnd: allDay ? plusIsoDays(day, 1) : localInstant(day, endHour),
      initialAllDay: allDay,
    });
  const sessionAction = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await load();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const scheduleTask = (task: PlannerTask, day: string, hour: number | null) => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
    return sessionAction(() =>
      api.createPlannerWorkSession({
        task_id: task.id,
        all_day: hour === null,
        start_value: hour === null ? day : localInstant(day, hour),
        end_value: hour === null ? plusIsoDays(day, 1) : localInstant(day, hour + 1),
        timezone,
      }),
    );
  };
  const dropTask = (taskId: string, day: string, hour: number | null) => {
    const task = data?.unscheduled_tasks.find((item) => item.id === taskId);
    if (task) void scheduleTask(task, day, hour);
  };
  const moveSession = (session: PlannerWorkSession, day: string, hour: number | null) => {
    if (hour === null) {
      const duration = session.all_day
        ? Math.max(
            1,
            Math.round(
              (Date.parse(`${session.end_value}T00:00:00Z`) - Date.parse(`${session.start_value}T00:00:00Z`)) /
                86400000,
            ),
          )
        : 1;
      void sessionAction(() =>
        api.updatePlannerWorkSession(session.id, {
          expected_revision: session.revision,
          all_day: true,
          start_value: day,
          end_value: plusIsoDays(day, duration),
          timezone: session.timezone,
        }),
      );
      return;
    }
    const duration = session.all_day
        ? 60
        : Math.max(15, (Date.parse(session.end_value) - Date.parse(session.start_value)) / 60000),
      start = localInstant(day, hour),
      end = new Date(Date.parse(start) + duration * 60000).toISOString();
    void sessionAction(() =>
      api.updatePlannerWorkSession(session.id, {
        expected_revision: session.revision,
        all_day: false,
        start_value: start,
        end_value: end,
        timezone: session.timezone,
      }),
    );
  };
  const moveSessionToDay = (session: PlannerWorkSession, day: string) =>
    moveSession(session, day, session.all_day ? null : localHour(session.start_value, session.timezone));
  const resizeSession = (session: PlannerWorkSession, delta: number) => {
    if (session.all_day) return;
    const end = new Date(
      Math.max(Date.parse(session.start_value) + 15 * 60000, Date.parse(session.end_value) + delta * 60000),
    ).toISOString();
    void sessionAction(() =>
      api.updatePlannerWorkSession(session.id, {
        expected_revision: session.revision,
        all_day: false,
        start_value: session.start_value,
        end_value: end,
        timezone: session.timezone,
      }),
    );
  };
  const resizedEvent = (occurrence: EventOccurrence, delta: number): EventOccurrence => ({
    ...occurrence,
    end_value: new Date(
      Math.max(Date.parse(occurrence.start_value) + 15 * 60000, Date.parse(occurrence.end_value) + delta * 60000),
    ).toISOString(),
  });
  const previewEventResize = (occurrence: EventOccurrence, delta: number) => {
    const series = events.find((item) => item.id === occurrence.series_id);
    if (series && !occurrence.all_day) setEditor({ occurrence: resizedEvent(occurrence, delta), series });
  };
  const resizeEvent = async (occurrence: EventOccurrence, delta: number) => {
    const series = events.find((item) => item.id === occurrence.series_id);
    if (!series || occurrence.all_day || !delta) return;
    const next = resizedEvent(occurrence, delta),
      input: CreatePlannerEvent = {
        title: next.title,
        description: next.description,
        location: next.location,
        meeting_url: next.meeting_url,
        participants: next.participants,
        epic_id: next.epic_id,
        color: next.color,
        all_day: false,
        start_value: next.start_value,
        end_value: next.end_value,
        timezone: next.timezone,
        recurrence_rule: next.recurring ? null : series.recurrence_rule,
      };
    try {
      if (next.recurring)
        await api.replacePlannerEventOccurrence(series.id, series.revision, next.occurrence_key, input);
      else await api.updatePlannerEvent(series.id, { ...input, expected_revision: series.revision });
      const nextEvents = await api.plannerEvents(false, false),
        nextSeries = nextEvents.find((item) => item.id === series.id) ?? series;
      setEvents(nextEvents);
      setEditor({ occurrence: next, series: nextSeries });
      await load();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const moveEvent = async (occurrence: EventOccurrence, day: string, hour?: number | null) => {
    const series = events.find((item) => item.id === occurrence.series_id);
    if (!series) return;
    let start: string, end: string;
    if (occurrence.all_day) {
      const duration = Math.max(
        1,
        Math.round(
          (Date.parse(`${occurrence.end_value}T00:00:00Z`) - Date.parse(`${occurrence.start_value}T00:00:00Z`)) /
            86400000,
        ),
      );
      start = day;
      end = plusIsoDays(day, duration);
    } else {
      const duration = Math.max(15, (Date.parse(occurrence.end_value) - Date.parse(occurrence.start_value)) / 60000),
        targetHour = hour ?? localHour(occurrence.start_value, occurrence.timezone);
      start = localInstant(day, targetHour);
      end = new Date(Date.parse(start) + duration * 60000).toISOString();
    }
    const input: CreatePlannerEvent = {
      title: occurrence.title,
      description: occurrence.description,
      location: occurrence.location,
      meeting_url: occurrence.meeting_url,
      participants: occurrence.participants,
      epic_id: occurrence.epic_id,
      color: occurrence.color,
      all_day: occurrence.all_day,
      start_value: start,
      end_value: end,
      timezone: occurrence.timezone,
      recurrence_rule: occurrence.recurring ? null : series.recurrence_rule,
    };
    try {
      if (occurrence.recurring)
        await api.replacePlannerEventOccurrence(series.id, series.revision, occurrence.occurrence_key, input);
      else await api.updatePlannerEvent(series.id, { ...input, expected_revision: series.revision });
      setEditor(null);
      await load();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const deleteEvent = (occurrence: EventOccurrence) => {
    const series = events.find((item) => item.id === occurrence.series_id);
    if (!series) return;
    setEditor(null);
    void sessionAction(async () => {
      if (occurrence.recurring) {
        await api.cancelPlannerEventOccurrence(series.id, series.revision, occurrence.occurrence_key);
        return;
      }
      const archived = await api.archivePlannerEvent(series.id, series.revision);
      await api.trashPlannerEvent(archived.id, archived.revision);
    });
  };
  const chooseIcal = async (file: File) => {
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("iCalendar files must be 10 MB or smaller");
      const preview = await api.previewPlannerIcal(await file.text(), "ics-file", timezone);
      setImporting({ preview, fileName: file.name });
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      if (importInput.current) importInput.current.value = "";
    }
  };
  const exportIcal = async () => {
    try {
      if (inTauri) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const path = await save({
          title: "Export Mosaic calendar",
          defaultPath: "mosaic-calendar.ics",
          filters: [{ name: "iCalendar", extensions: ["ics"] }],
        });
        if (path) await api.exportPlannerIcalFile(path);
      } else {
        const content = await api.exportPlannerIcal(),
          url = URL.createObjectURL(new Blob([content], { type: "text/calendar" })),
          link = document.createElement("a");
        link.href = url;
        link.download = "mosaic-calendar.ics";
        link.click();
        URL.revokeObjectURL(url);
      }
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const toggleSubscription = async (id: string, visible: boolean) => {
    const item = overlay.subscriptions.find((value) => value.id === id);
    if (!item) return;
    try {
      await api.updateCalendarSubscription(item.id, item.name, item.color, visible, item.refresh_minutes);
      await load();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const importOverlay = async (item: CalendarOverlayOccurrence) => {
    try {
      await api.createPlannerEvent({
        title: item.title,
        description: item.description,
        location: item.location,
        meeting_url: item.meeting_url,
        participants: [],
        epic_id: null,
        color: item.color,
        all_day: item.all_day,
        start_value: item.start_value,
        end_value: item.end_value,
        timezone: item.timezone,
        recurrence_rule: null,
      });
      setOverlayDetails(null);
      await load();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const selectedData = data ?? emptyRange(from, to),
    today = isoDay(new Date());
  return (
    <div className={`planner-calendar-page ${editor || overlayDetails ? "with-editor" : ""}`}>
      <main className="planner-calendar">
        <Toolbar>
          <button className="icon" aria-label="Previous period" onClick={() => step(-1)}>
            <ChevronLeft size={16} />
          </button>
          <button className="icon" aria-label="Next period" onClick={() => step(1)}>
            <ChevronRight size={16} />
          </button>
          <button onClick={() => setAnchor(atNoon(new Date()))}>Today</button>
          <h2 className="calendar-title">{title}</h2>
          <span className="spacer" />
          <details className="calendar-chooser">
            <summary>Calendars</summary>
            <div>
              <label>
                <input
                  type="checkbox"
                  checked={show.events}
                  onChange={(event) => setShow((value) => ({ ...value, events: event.target.checked }))}
                />{" "}
                Local events
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={show.sessions}
                  onChange={(event) => setShow((value) => ({ ...value, sessions: event.target.checked }))}
                />{" "}
                Work sessions
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={show.due}
                  onChange={(event) => setShow((value) => ({ ...value, due: event.target.checked }))}
                />{" "}
                Due dates
              </label>
              {overlay.subscriptions.map((item) => (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    checked={item.visible}
                    onChange={(event) => void toggleSubscription(item.id, event.target.checked)}
                  />
                  <i style={{ background: item.color }} /> {item.name} 🔒
                </label>
              ))}
              <button onClick={() => setArchivesOpen(true)}>Archived local events…</button>
              <button onClick={() => setSourcesOpen(true)}>Manage subscriptions…</button>
            </div>
          </details>
          <input
            ref={importInput}
            hidden
            type="file"
            accept=".ics,text/calendar"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void chooseIcal(file);
            }}
          />
          <button aria-label="Import iCalendar file" onClick={() => importInput.current?.click()}>
            <Upload size={14} /> Import
          </button>
          <button aria-label="Export iCalendar file" onClick={() => void exportIcal()}>
            <Download size={14} /> Export
          </button>
          <button
            onClick={() => {
              setSelectedRange(null);
              newEvent();
            }}
          >
            New event
          </button>
          <button
            className="icon"
            aria-label="Refresh calendar"
            disabled={loading}
            onClick={() => void refreshSubscriptions(true)}
          >
            <RefreshCw size={15} />
          </button>
          <Segmented<CalendarMode>
            value={mode}
            options={[
              { value: "month", label: "Month" },
              { value: "week", label: "Week" },
              { value: "day", label: "Day" },
            ]}
            onChange={setMode}
          />
        </Toolbar>
        {error && <p className="error-text calendar-error">{error}</p>}
        {loading && !data && <p className="panel-meta calendar-loading">Loading planner calendar…</p>}
        <div className={`planner-calendar-content mode-${mode}`}>
          {mode === "month" ? (
            <MonthView
              days={days}
              anchor={anchor}
              data={selectedData}
              overlays={overlay.occurrences}
              today={today}
              show={show}
              onDay={(day) => {
                setAnchor(atNoon(new Date(`${day}T12:00:00`)));
                setMode("day");
              }}
              onEvent={openEvent}
              onOverlay={(item) => {
                setSelectedRange(null);
                setOverlayDetails(item);
              }}
              onEventMove={(event, day) => void moveEvent(event, day)}
              onSessionMove={moveSessionToDay}
              onEventDelete={deleteEvent}
              onSessionDelete={(session) =>
                void sessionAction(() => api.cancelPlannerWorkSession(session.id, session.revision))
              }
            />
          ) : (
            <>
              <WeekView
                days={days}
                data={selectedData}
                overlays={overlay.occurrences}
                today={today}
                show={show}
                selectedRange={selectedRange}
                onEvent={openEvent}
                onOverlay={(item) => {
                  setSelectedRange(null);
                  setOverlayDetails(item);
                }}
                onEmptyRange={(day, start, end) => {
                  setSelectedRange({ day, startHour: start, endHour: end });
                  newEvent(day, start, end);
                }}
                onTaskDrop={dropTask}
                onSessionMove={moveSession}
                onEventMove={(event, day, hour) => void moveEvent(event, day, hour)}
                onEventResizePreview={previewEventResize}
                onEventResize={(event, minutes) => void resizeEvent(event, minutes)}
                onSessionResizeStart={() => {
                  setEditor(null);
                  setSelectedRange(null);
                }}
                onSessionResize={resizeSession}
                onEventDelete={deleteEvent}
                onSessionCancel={(session) =>
                  void sessionAction(() => api.cancelPlannerWorkSession(session.id, session.revision))
                }
              />
              <UnscheduledTray
                tasks={selectedData.unscheduled_tasks}
                epics={epics}
                onSchedule={(task) => void scheduleTask(task, isoDay(anchor), 9)}
              />
            </>
          )}
        </div>
      </main>
      {editor && (
        <EventEditor
          key={editor.series?.id ?? `new:${editor.initialStart ?? ""}:${editor.initialEnd ?? ""}`}
          {...editor}
          epics={epics}
          onClose={() => {
            setEditor(null);
            setSelectedRange(null);
          }}
          onDone={() => {
            setEditor(null);
            setSelectedRange(null);
            void load();
          }}
        />
      )}
      {overlayDetails && (
        <OverlayDetails
          occurrence={overlayDetails}
          onImport={() => void importOverlay(overlayDetails)}
          onClose={() => setOverlayDetails(null)}
        />
      )}{" "}
      {importing && (
        <IcalImportWizard
          {...importing}
          onCancel={() => setImporting(null)}
          onDone={() => {
            setImporting(null);
            void load();
          }}
        />
      )}
      {sourcesOpen && (
        <CalendarSourcesDialog
          subscriptions={overlay.subscriptions}
          onClose={() => setSourcesOpen(false)}
          onChange={async () => {
            await refreshSubscriptions(false);
          }}
        />
      )}
      {archivesOpen && <EventArchiveDialog onClose={() => setArchivesOpen(false)} onChange={load} />}
    </div>
  );
}
