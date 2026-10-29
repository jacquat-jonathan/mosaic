import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Notice } from "../design-system/components";
import { api } from "../ipc/api";
import { errorMessage, type Days, type DayTask } from "../ipc/types";
import { useVault } from "../state/vault";
import { usePlanning } from "../state/planning";
import { dayStamp } from "../daily";
import { openDailyNote } from "../actions";
import { CalendarTaskList } from "./CalendarTaskList";
import { DesignSystemScope } from "./DesignSystemScope";
import "./calendarContext.css";

export function CalendarContext() {
  const root = useVault((state) => state.vault?.root),
    day = usePlanning((state) => state.selectedDay),
    revision = useVault((state) => state.revision);
  const [data, setData] = useState<Days | null>(null),
    [error, setError] = useState<string | null>(null),
    [tick, setTick] = useState(0),
    [pending, setPending] = useState(false);
  const live = useRef(true),
    lock = useRef(false),
    focusAfter = useRef(false),
    retry = useRef<HTMLButtonElement>(null),
    overdue = useRef<HTMLHeadingElement>(null),
    first = useRef<HTMLButtonElement>(null);
  const current = useCallback(() => live.current && root === useVault.getState().vault?.root, [root]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    void api.days(day, day, dayStamp()).then(
      (value) => {
        if (active && current()) setData(value);
      },
      (reason) => {
        if (active && current()) setError(errorMessage(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [day, revision, tick, current]);
  useEffect(() => {
    if (focusAfter.current && (data || error) && !pending) {
      (error && !data ? retry.current : (overdue.current ?? first.current))?.focus();
      focusAfter.current = false;
    }
  }, [data, error, pending]);
  const toggle = async (task: DayTask, done: boolean) => {
    if (lock.current || !current()) return;
    lock.current = true;
    setPending(true);
    setError(null);
    const previous = document.activeElement;
    try {
      await api.setTask(task.path, task.line, task.text, done);
      if (current()) {
        focusAfter.current = document.activeElement === previous || document.activeElement === document.body;
        setData(null);
        setTick((value) => value + 1);
      }
    } catch (reason) {
      if (current()) {
        setError(errorMessage(reason));
        focusAfter.current = document.activeElement === previous || document.activeElement === document.body;
      }
    } finally {
      lock.current = false;
      if (current()) setPending(false);
    }
  };
  return (
    <DesignSystemScope className="calendar-context" role="group" aria-label="Calendar details">
      <h3>{day}</h3>
      <Button
        ref={first}
        variant="secondary"
        onClick={() => {
          if (current()) void openDailyNote(new Date(`${day}T12:00`), { newTab: true });
        }}
      >
        Open daily note
      </Button>
      {error && (
        <Notice tone="error">
          {error}
          {!data && (
            <Button
              ref={retry}
              onClick={() => {
                focusAfter.current = true;
                setTick((value) => value + 1);
              }}
            >
              Retry calendar details
            </Button>
          )}
        </Notice>
      )}
      {!data && !error && (
        <p className="mds-hint" role="status">
          Loading calendar details…
        </p>
      )}
      {pending && (
        <p className="mds-hint" role="status">
          Saving task…
        </p>
      )}
      {data && (
        <>
          <p className="mds-hint">
            {data.days[0]?.tasks.filter((task) => task.status === "open").length ?? 0} open tasks
          </p>
          <h3 ref={overdue} tabIndex={-1}>
            Overdue
          </h3>
          <CalendarTaskList tasks={data.overdue} pending={pending} onTick={(task, done) => void toggle(task, done)} />
          {!data.overdue.length && <p className="mds-hint">No overdue tasks.</p>}
        </>
      )}
    </DesignSystemScope>
  );
}
