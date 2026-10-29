import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, IconButton, Notice } from "../../design-system/components";
import { X } from "lucide-react";
import { useVault } from "../../state/vault";
import { DesignSystemScope } from "../DesignSystemScope";
import "./plannerEditor.css";
import { api } from "../../ipc/api";
import {
  errorMessage,
  type CreatePlannerEvent,
  type EventOccurrence,
  type PlannerEpic,
  type PlannerEvent,
} from "../../ipc/types";
import { formatCalendarDate, fromLocalInput, parseCalendarDate, toLocalInput } from "./calendarModel";
import { ActivityTimeline } from "./ActivityTimeline";

type Repeat = "none" | "daily" | "weekdays" | "weekly" | "monthly";
function repeatFrom(rule: string | null): Repeat {
  if (!rule) return "none";
  if (rule.includes("BYDAY=MO,TU,WE,TH,FR")) return "weekdays";
  if (rule.includes("FREQ=DAILY")) return "daily";
  if (rule.includes("FREQ=WEEKLY")) return "weekly";
  return "monthly";
}
function untilFrom(rule: string | null) {
  const match = /UNTIL=(\d{4})(\d{2})(\d{2})/.exec(rule ?? "");
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}
function intervalFrom(rule: string | null) {
  return Number(/INTERVAL=(\d+)/.exec(rule ?? "")?.[1] ?? 1);
}
function nextDay(value: string) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function localParts(value: string, allDay: boolean, fallbackTime: string) {
  const local = allDay ? value : toLocalInput(value);
  return { day: local.slice(0, 10), time: local.slice(11, 16) || fallbackTime };
}
function localInstant(day: string, time: string) {
  return day && time ? fromLocalInput(`${day}T${time}`) : "";
}
function recurrence(repeat: Repeat, interval: number, until: string) {
  if (repeat === "none") return null;
  const freq = repeat === "daily" ? "DAILY" : repeat === "monthly" ? "MONTHLY" : "WEEKLY";
  const parts = [`FREQ=${freq}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (repeat === "weekdays") parts.push("BYDAY=MO,TU,WE,TH,FR");
  if (until) parts.push(`UNTIL=${until.replaceAll("-", "")}`);
  return parts.join(";");
}

function CalendarDateInput({ value, onChange }: { value: string; onChange(value: string): void }) {
  const [text, setText] = useState(() => formatCalendarDate(value));
  useEffect(() => setText(formatCalendarDate(value)), [value]);
  return (
    <input
      className="mds-input"
      type="text"
      inputMode="numeric"
      placeholder="dd/mm/yyyy"
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const parsed = parseCalendarDate(next);
        if (parsed) onChange(parsed);
        else if (!next.trim()) onChange("");
      }}
      onBlur={() => {
        const parsed = parseCalendarDate(text);
        setText(parsed ? formatCalendarDate(parsed) : formatCalendarDate(value));
      }}
    />
  );
}

export function EventEditor({
  occurrence,
  series,
  epics,
  initialStart,
  initialEnd,
  initialAllDay = false,
  onClose,
  onDone,
}: {
  occurrence: EventOccurrence | null;
  series: PlannerEvent | null;
  epics: PlannerEpic[];
  initialStart?: string;
  initialEnd?: string;
  initialAllDay?: boolean;
  onClose(): void;
  onDone(): void;
}) {
  const root = useVault((state) => state.vault?.root),
    live = useRef(true),
    lock = useRef(false);
  const current = () => live.current && root === useVault.getState().vault?.root;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const scopeName = useId();
  const original = occurrence ?? series,
    timezone = original?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const [title, setTitle] = useState(original?.title ?? ""),
    [description, setDescription] = useState(original?.description ?? ""),
    [location, setLocation] = useState(original?.location ?? ""),
    [meeting, setMeeting] = useState(original?.meeting_url ?? ""),
    [participants, setParticipants] = useState(original?.participants.join(", ") ?? ""),
    [epic, setEpic] = useState(original?.epic_id ?? ""),
    [color, setColor] = useState(original?.color ?? ""),
    [allDay, setAllDay] = useState(original?.all_day ?? initialAllDay);
  const initialStartValue = original?.start_value ?? initialStart ?? new Date().toISOString(),
    initialEndValue = original?.end_value ?? initialEnd ?? new Date(Date.now() + 3600000).toISOString();
  const startParts = localParts(initialStartValue, allDay, "09:00"),
    endParts = localParts(initialEndValue, allDay, "10:00");
  const [startDay, setStartDay] = useState(startParts.day),
    [startTime, setStartTime] = useState(startParts.time),
    [endDay, setEndDay] = useState(endParts.day),
    [endTime, setEndTime] = useState(endParts.time);
  useEffect(() => {
    const nextStart = localParts(initialStartValue, allDay, "09:00"),
      nextEnd = localParts(initialEndValue, allDay, "10:00");
    setStartDay(nextStart.day);
    setStartTime(nextStart.time);
    setEndDay(nextEnd.day);
    setEndTime(nextEnd.time);
  }, [initialStartValue, initialEndValue, allDay]);
  const [repeat, setRepeat] = useState<Repeat>(repeatFrom(series?.recurrence_rule ?? null)),
    [interval, setInterval] = useState(intervalFrom(series?.recurrence_rule ?? null)),
    [until, setUntil] = useState(untilFrom(series?.recurrence_rule ?? null)),
    [scope, setScope] = useState<"occurrence" | "series">(occurrence?.recurring ? "occurrence" : "series"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const isExisting = !!series,
    recurring = !!occurrence?.recurring;
  const inheritedColor = epics.find((item) => item.id === epic)?.color ?? "#5b8def",
    visibleColor = color || inheritedColor;
  const input = useMemo<CreatePlannerEvent>(
    () => ({
      title: title.trim(),
      description,
      location,
      meeting_url: meeting.trim() || null,
      participants: participants
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      epic_id: epic || null,
      color: color || null,
      all_day: allDay,
      start_value: allDay ? startDay : localInstant(startDay, startTime),
      end_value: allDay ? endDay : localInstant(endDay, endTime),
      timezone,
      recurrence_rule: scope === "occurrence" ? null : recurrence(repeat, interval, until),
    }),
    [
      title,
      description,
      location,
      meeting,
      participants,
      epic,
      color,
      allDay,
      startDay,
      startTime,
      endDay,
      endTime,
      timezone,
      scope,
      repeat,
      interval,
      until,
    ],
  );
  const run = async (action: () => Promise<unknown>) => {
    if (lock.current || !current()) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      if (current()) onDone();
    } catch (reason) {
      if (current()) setError(errorMessage(reason));
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  const save = () =>
    run(() =>
      !series
        ? api.createPlannerEvent(input)
        : recurring && scope === "occurrence"
          ? api.replacePlannerEventOccurrence(series.id, series.revision, occurrence!.occurrence_key, input)
          : api.updatePlannerEvent(series.id, { ...input, expected_revision: series.revision }),
    );
  const remove = () =>
    series &&
    run(() =>
      recurring && scope === "occurrence"
        ? api.cancelPlannerEventOccurrence(series.id, series.revision, occurrence!.occurrence_key)
        : api.archivePlannerEvent(series.id, series.revision),
    );
  const toggleAllDay = (checked: boolean) => {
    setAllDay(checked);
    if (checked && endDay <= startDay) setEndDay(nextDay(startDay));
  };
  return (
    <DesignSystemScope
      as="aside"
      className="planner-editor event-editor planner-editor-design"
      aria-label={isExisting ? `Edit ${title}` : "New event"}
    >
      <header>
        <h2>{isExisting ? "Event" : "New event"}</h2>
        <IconButton label="Close event editor" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      {error && <Notice tone="error">{error}</Notice>}
      <fieldset className="planner-editor-fields" disabled={busy} aria-label="Event details">
        {recurring && (
          <fieldset className="event-scope">
            <legend>Edit</legend>
            <label>
              <input
                name={scopeName}
                type="radio"
                checked={scope === "occurrence"}
                onChange={() => setScope("occurrence")}
              />{" "}
              This occurrence
            </label>
            <label>
              <input name={scopeName} type="radio" checked={scope === "series"} onChange={() => setScope("series")} />{" "}
              Entire series
            </label>
          </fieldset>
        )}
        <label>
          Title
          <input className="mds-input" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          Description
          <textarea
            className="mds-input"
            rows={4}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label className="event-check">
          <input type="checkbox" checked={allDay} onChange={(event) => toggleAllDay(event.target.checked)} /> All day
        </label>
        <div className={`event-date-fields ${allDay ? "all-day" : ""}`}>
          <label>
            Start day
            <CalendarDateInput value={startDay} onChange={setStartDay} />
          </label>
          {!allDay && (
            <label>
              Start time
              <input
                className="mds-input"
                type="time"
                step="900"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
              />
            </label>
          )}
          <label>
            End day
            <CalendarDateInput value={endDay} onChange={setEndDay} />
          </label>
          {!allDay && (
            <label>
              End time
              <input
                className="mds-input"
                type="time"
                step="900"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
              />
            </label>
          )}
        </div>
        <p className="panel-meta">Time zone: {timezone}</p>
        {scope === "series" && (
          <>
            <div className="planner-editor-row">
              <label>
                Repeat
                <select
                  className="mds-input"
                  value={repeat}
                  onChange={(event) => setRepeat(event.target.value as Repeat)}
                >
                  <option value="none">Does not repeat</option>
                  <option value="daily">Daily</option>
                  <option value="weekdays">Weekdays</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              {repeat !== "none" && (
                <label>
                  Every
                  <input
                    className="mds-input"
                    type="number"
                    min="1"
                    max="366"
                    value={interval}
                    onChange={(event) => setInterval(Number(event.target.value))}
                  />
                </label>
              )}
            </div>
            {repeat !== "none" && (
              <label>
                Repeat until
                <input
                  className="mds-input"
                  type="date"
                  value={until}
                  onChange={(event) => setUntil(event.target.value)}
                />
              </label>
            )}
          </>
        )}
        <label>
          Epic
          <select className="mds-input" value={epic} onChange={(event) => setEpic(event.target.value)}>
            <option value="">No epic</option>
            {epics
              .filter((item) => !item.archived_at)
              .map((item) => (
                <option value={item.id} key={item.id}>
                  {item.title}
                </option>
              ))}
          </select>
        </label>
        <label>
          Color
          <span className="event-color-control">
            <input
              className="mds-input"
              aria-label="Color"
              type="color"
              value={visibleColor}
              onChange={(event) => setColor(event.target.value)}
            />
            <output>
              <i style={{ backgroundColor: visibleColor }} />
              {color ? visibleColor : epic ? "Epic color" : "Default color"}
            </output>
            {color && (
              <Button type="button" onClick={() => setColor("")}>
                Use {epic ? "epic" : "default"}
              </Button>
            )}
          </span>
        </label>
        <label>
          Location
          <input className="mds-input" value={location} onChange={(event) => setLocation(event.target.value)} />
        </label>
        <label>
          Meeting URL
          <input
            className="mds-input"
            type="url"
            value={meeting}
            onChange={(event) => setMeeting(event.target.value)}
          />
        </label>
        <label>
          Participants
          <input
            className="mds-input"
            value={participants}
            placeholder="anna@example.com, sam@example.com"
            onChange={(event) => setParticipants(event.target.value)}
          />
        </label>
        {series && <ActivityTimeline designSystem kind="event" id={series.id} revision={series.revision} />}
      </fieldset>
      <footer>
        {series ? (
          <Button variant="danger" disabled={busy} onClick={() => void remove()}>
            {recurring && scope === "occurrence" ? "Delete occurrence" : "Archive"}
          </Button>
        ) : (
          <span />
        )}
        <Button
          variant="secondary"
          disabled={busy || !title.trim() || !startDay || !endDay || (!allDay && (!startTime || !endTime))}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
      </footer>
    </DesignSystemScope>
  );
}
