// The calendar tab: each day's tasks, from daily notes (named after their date) and from tasks
// anywhere with a 📅 due date (crates/mosaic-core/src/days.rs). Month shows counts and the first
// tasks of each day; week lists every task, tickable. Clicking a day opens its daily note.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api, onVaultChanged } from "../ipc/api";
import { errorMessage, type Day, type DayTask, type Days } from "../ipc/types";
import { dayStamp } from "../daily";
import { openDailyNote } from "../actions";
import { usePlanning } from "../state/planning";
import { useWorkspace } from "../state/workspace";
import { Segmented, Toolbar } from "../viewers/Toolbar";
import { addDays, atNoon, counts, monthGrid, progress, weekRange } from "./calendar";

type Mode = "month" | "week" | "day";
const MODE_KEY = "mosaic:calendar-mode";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const noteName = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/i, "");
const parseDay = (s: string) => new Date(`${s}T12:00`);
/** A task's text without its 📅 date (the calendar shows it on that day already). */
const shortText = (t: DayTask) => t.text.replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/u, "").trim() || "(empty task)";

function storedMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "month" ? "month" : "week";
  } catch {
    return "week";
  }
}

export function CalendarView({ initialMode }: { initialMode?: Mode }) {
  const [mode, setModeState] = useState<Mode>(initialMode ?? storedMode);
  const selectedDay = usePlanning(s => s.selectedDay);
  const [anchor, setAnchor] = useState(() => atNoon(new Date()));
  const [data, setData] = useState<Days | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = dayStamp();
  const range = useMemo(() => (mode === "month" ? monthGrid(anchor) : mode === "day" ? { from: anchor, to: anchor } : weekRange(anchor)), [mode, anchor]);
  const from = dayStamp(range.from);
  const to = dayStamp(range.to);

  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // Only a convenience.
    }
  };

  const load = useCallback(() => {
    api.days(from, to, dayStamp()).then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e) => setError(errorMessage(e)),
    );
  }, [from, to]);

  useEffect(() => {
    load();
    let pending: ReturnType<typeof setTimeout> | undefined;
    let off: (() => void) | undefined;
    let live = true;
    void onVaultChanged(() => {
      clearTimeout(pending);
      pending = setTimeout(load, 300);
    }).then((f) => (live ? (off = f) : f()));
    return () => {
      live = false;
      clearTimeout(pending);
      off?.();
    };
  }, [load]);

  const step = (n: number) => setAnchor((a) => (mode === "month" ? atNoon(new Date(a.getFullYear(), a.getMonth() + n, 1)) : addDays(a, (mode === "day" ? 1 : 7) * n)));
  const title =
    mode === "month"
      ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : `${range.from.toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${range.to.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;

  const tick = (t: DayTask, done: boolean) =>
    api.setTask(t.path, t.line, t.text, done).then(load, (e) => {
      setError((e as { code?: string }).code === "conflict" ? "That note changed meanwhile; the calendar is refreshed." : errorMessage(e));
      load();
    });
  const openDay = (date: string) => usePlanning.setState({ selectedDay: date });

  const showOverdue = !!data?.overdue.length && today >= from && today <= to;
  return (
    <div className="calendar">
      <Toolbar>
        <button className="icon" aria-label={mode === "month" ? "Previous month" : mode === "day" ? "Previous day" : "Previous week"} onClick={() => step(-1)}>
          <ChevronLeft size={16} />
        </button>
        <button className="icon" aria-label={mode === "month" ? "Next month" : mode === "day" ? "Next day" : "Next week"} onClick={() => step(1)}>
          <ChevronRight size={16} />
        </button>
        <button onClick={() => { setAnchor(atNoon(new Date())); usePlanning.setState({ selectedDay: dayStamp() }); }}>Today</button>
        <h2 className="calendar-title">{title}</h2>
        <span className="spacer" />
        <Segmented<Mode>
          value={mode}
          options={[
            { value: "month", label: "Month" },
            { value: "week", label: "Week" },
            { value: "day", label: "Day" },
          ]}
          onChange={setMode}
        />
      </Toolbar>
      <div className="calendar-selection"><span>Selected: {selectedDay}</span><button onClick={() => void openDailyNote(parseDay(selectedDay), { newTab: true })}>Open daily note</button></div>
      {error && <p className="error-text calendar-error">{error}</p>}
      {showOverdue && (
        <section className="calendar-overdue" aria-label="Overdue">
          <h3>Overdue ({data!.overdue.length})</h3>
          <TaskList tasks={data!.overdue} onTick={tick} showNote />
        </section>
      )}
      {!data ? (
        <div className="panel-meta">Loading…</div>
      ) : mode === "month" ? (
        <Month days={data.days} month={anchor.getMonth()} today={today} selected={selectedDay} onOpen={openDay} />
      ) : (
        <Week days={data.days} today={today} selected={selectedDay} onOpen={openDay} onTick={tick} />
      )}
    </div>
  );
}

function Month({ days, month, today, selected, onOpen }: { days: Day[]; month: number; today: string; selected: string; onOpen(date: string, note: string | null): void }) {
  return (
    <div className="calendar-month" role="grid">
      {WEEKDAYS.map((w) => (
        <div key={w} className="calendar-weekday" role="columnheader">
          {w}
        </div>
      ))}
      {days.map((d) => {
        const date = parseDay(d.date);
        const c = counts(d.tasks);
        const shown = d.tasks.filter((t) => t.depth === 0 && (t.status === "open" || t.status === "done"));
        return (
          <button
            key={d.date}
            role="gridcell"
            className={`calendar-cell ${d.date === selected ? "selected" : ""} ${date.getMonth() !== month ? "other-month" : ""} ${d.date === today ? "today" : ""} ${d.note ? "has-note" : ""}`}
            aria-selected={d.date === selected}
            title={d.note ? `Select ${d.date} · ${noteName(d.note)}` : `Select ${d.date}`}
            onClick={() => onOpen(d.date, d.note)}
          >
            <span className="calendar-date">{date.getDate()}</span>
            {(c.open > 0 || c.done > 0) && (
              <span className="calendar-counts">
                {c.open > 0 && <span className="open">{c.open} open</span>}
                {c.done > 0 && <span className="done">{c.done} done</span>}
              </span>
            )}
            {shown.slice(0, 3).map((t) => (
              <span key={`${t.path}:${t.line}`} className={`calendar-chip status-${t.status} ${t.daily ? "" : "dated"}`}>
                {shortText(t)}
              </span>
            ))}
            {shown.length > 3 && <span className="calendar-more">+{shown.length - 3} more</span>}
          </button>
        );
      })}
    </div>
  );
}

function Week({ days, today, selected, onOpen, onTick }: { days: Day[]; today: string; selected: string; onOpen(date: string, note: string | null): void; onTick(t: DayTask, done: boolean): void }) {
  return (
    <div className="calendar-week">
      {days.map((d) => {
        const date = parseDay(d.date);
        return (
          <section key={d.date} className={`calendar-day ${d.date === selected ? "selected" : ""} ${d.date === today ? "today" : ""}`} aria-label={d.date}>
            <button aria-pressed={d.date === selected} className="calendar-day-head" title={d.note ? `Select ${d.date} · ${noteName(d.note)}` : `Select ${d.date}`} onClick={() => onOpen(d.date, d.note)}>
              <span className="calendar-weekday">{WEEKDAYS[(date.getDay() + 6) % 7]}</span> <span className="calendar-date">{date.getDate()}</span>
            </button>
            {d.tasks.length ? <TaskList tasks={d.tasks} onTick={onTick} /> : <p className="calendar-empty">{d.note ? "No tasks" : ""}</p>}
          </section>
        );
      })}
    </div>
  );
}

export function TaskList({ tasks, onTick, showNote = false }: { tasks: DayTask[]; onTick(t: DayTask, done: boolean): void; showNote?: boolean }) {
  const prog = useMemo(() => progress(tasks), [tasks]);
  return (
    <ul className="calendar-tasks">
      {tasks.map((t) => {
        const p = prog.get(`${t.path}:${t.line}`);
        // Moved and cancelled tasks are closed on purpose: shown, not tickable.
        const tickable = t.status === "open" || t.status === "done";
        return (
          <li key={`${t.path}:${t.line}`} className={`calendar-task status-${t.status}`} style={{ paddingLeft: t.depth * 16 }}>
            <input type="checkbox" checked={t.status === "done"} disabled={!tickable} aria-label={t.text || "Task"} onChange={(e) => onTick(t, e.target.checked)} />
            <span className="calendar-task-text">
              {t.status === "moved" && <span className="calendar-moved" title="Moved to a later day">→ </span>}
              {showNote ? t.text || "(empty task)" : shortText(t)}
              {p && <span className="calendar-progress">{` ${p.done}/${p.total}`}</span>}
              {(showNote || !t.daily) && (
                <button className="calendar-note-link" title={`Open ${t.path}`} onClick={() => void useWorkspace.getState().open(t.path, { newTab: true })}>
                  {noteName(t.path)}
                </button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
