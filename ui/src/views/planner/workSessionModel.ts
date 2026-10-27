import type { PlannerWorkSession, UpdatePlannerWorkSession } from "../../ipc/types";
import { addDays, isoDay, localDate } from "./calendarModel";

export type WorkSessionDraft = {
  day: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
};

const localTime = (value: string, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  return `${parts.find((part) => part.type === "hour")?.value ?? "00"}:${parts.find((part) => part.type === "minute")?.value ?? "00"}`;
};

/** Convert a wall-clock value in an IANA zone to an instant without quantizing its minutes. */
export function zonedInstant(day: string, time: string, timezone: string): string {
  const [year, month, date] = day.split("-").map(Number),
    [hour, minute] = time.split(":").map(Number),
    desired = Date.UTC(year, month - 1, date, hour, minute);
  let guess = desired;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(guess)),
      part = (kind: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === kind)?.value),
      rendered = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute")),
      correction = desired - rendered;
    guess += correction;
    if (!correction) break;
  }
  return new Date(guess).toISOString();
}

export function workSessionDraft(session: PlannerWorkSession): WorkSessionDraft {
  if (session.all_day) return { day: session.start_value, startTime: "09:00", endTime: "10:00", allDay: true };
  return {
    day: localDate(session.start_value, session.timezone),
    startTime: localTime(session.start_value, session.timezone),
    endTime: localTime(session.end_value, session.timezone),
    allDay: false,
  };
}

export function workSessionError(draft: WorkSessionDraft, timezone: string): string | null {
  if (!draft.day) return "Choose a day.";
  if (draft.allDay) return null;
  if (!draft.startTime || !draft.endTime) return "Enter a start and end time.";
  if (
    Date.parse(zonedInstant(draft.day, draft.endTime, timezone)) <=
    Date.parse(zonedInstant(draft.day, draft.startTime, timezone))
  )
    return "End time must be after start time.";
  return null;
}

export function workSessionUpdate(session: PlannerWorkSession, draft: WorkSessionDraft): UpdatePlannerWorkSession {
  return {
    expected_revision: session.revision,
    all_day: draft.allDay,
    start_value: draft.allDay ? draft.day : zonedInstant(draft.day, draft.startTime, session.timezone),
    end_value: draft.allDay
      ? isoDay(addDays(new Date(`${draft.day}T12:00:00`), 1))
      : zonedInstant(draft.day, draft.endTime, session.timezone),
    timezone: session.timezone,
  };
}
