// Date ranges and task counts for the calendar view (views/CalendarView.tsx). Weeks start on Monday.

import type { DayTask } from "../ipc/types";

/** Noon of the day, so adding days never trips over a daylight-saving change. */
export const atNoon = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);

export function addDays(d: Date, n: number): Date {
  const r = atNoon(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** The Monday of `d`'s week. */
export function startOfWeek(d: Date, sunday = false): Date {
  return addDays(d, -(sunday ? d.getDay() : (d.getDay() + 6) % 7));
}

/** The 6 weeks shown for `d`'s month: from the Monday on or before the 1st. */
export function monthGrid(d: Date, sunday = false): { from: Date; to: Date } {
  const from = startOfWeek(new Date(d.getFullYear(), d.getMonth(), 1, 12), sunday);
  return { from, to: addDays(from, 41) };
}

export function weekRange(d: Date, sunday = false): { from: Date; to: Date } {
  const from = startOfWeek(d, sunday);
  return { from, to: addDays(from, 6) };
}

/** Tasks with subtasks: how many of their direct and nested subtasks are done ("2/3"). */
export function progress(tasks: DayTask[]): Map<string, { done: number; total: number }> {
  const key = (path: string, line: number) => `${path}:${line}`;
  const parentOf = new Map(tasks.map((t) => [key(t.path, t.line), t.parent === null ? null : key(t.path, t.parent)]));
  const out = new Map<string, { done: number; total: number }>();
  for (const t of tasks) {
    if (t.status === "moved" || t.status === "cancelled") continue;
    for (let up = parentOf.get(key(t.path, t.line)); up; up = parentOf.get(up) ?? null) {
      const p = out.get(up) ?? { done: 0, total: 0 };
      p.total++;
      if (t.status === "done") p.done++;
      out.set(up, p);
    }
  }
  return out;
}

/** "3 open · 2 done" for a month cell (moved and cancelled tasks don't count). */
export function counts(tasks: DayTask[]): { open: number; done: number } {
  return {
    open: tasks.filter((t) => t.status === "open").length,
    done: tasks.filter((t) => t.status === "done").length,
  };
}
