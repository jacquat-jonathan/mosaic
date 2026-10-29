import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Notice } from "../design-system/components";
import { cell } from "../editor/queryBlock";
import { api } from "../ipc/api";
import { errorMessage, type QueryResult, type QueryRow } from "../ipc/types";
import { usePlanning } from "../state/planning";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { DesignSystemScope } from "./DesignSystemScope";
import "./taskQueryView.css";

export function TaskQueryView({ kind, id }: { kind: string; id: string }) {
  const root = useVault((s) => s.vault?.root);
  const revision = useVault((s) => s.revision);
  const saved = usePlanning((s) => s.views.find((view) => view.id === id));
  const title =
    kind === "planning"
      ? (saved?.title ?? "Planning")
      : kind === "query"
        ? "Query"
        : kind === "overdue"
          ? "Overdue"
          : kind === "projects"
            ? "Project tasks"
            : "Tasks";
  const query =
    kind === "query"
      ? id
      : kind === "planning"
        ? saved?.query
        : kind === "overdue"
          ? "task:open due<today sort:due limit:1000"
          : kind === "projects"
            ? "task:open tag:project sort:due limit:1000"
            : "task:open sort:due limit:1000";
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState(false);
  const [tick, setTick] = useState(0);
  const live = useRef(true),
    busy = useRef(false);
  const container = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<{ key: string; index: number } | null>(null);
  const current = useCallback(() => live.current && useVault.getState().vault?.root === root, [root]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setResult(null);
    setError(null);
    setLoadError(false);
    if (query)
      void api.query(query).then(
        (next) => {
          if (active && current()) setResult(next);
        },
        (reason) => {
          if (active && current()) {
            setError(errorMessage(reason));
            setLoadError(true);
          }
        },
      );
    return () => {
      active = false;
    };
  }, [query, revision, tick, current]);
  useEffect(() => {
    if (pending || !focusAfter.current || (!result && !loadError)) return;
    const intent = focusAfter.current;
    focusAfter.current = null;
    const controls = [
      ...(container.current?.querySelectorAll<HTMLInputElement>("input[type=checkbox]:not(:disabled)") ?? []),
    ];
    const target =
      controls.find((item) => item.dataset.taskKey === intent.key) ??
      controls[Math.min(intent.index, controls.length - 1)];
    (loadError ? retry.current : (target ?? heading.current))?.focus();
  }, [result, pending, loadError]);
  async function toggle(row: QueryRow, done: boolean, index: number) {
    if (!row.task || busy.current || !current()) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const previousFocus = document.activeElement;
    try {
      await api.setTask(row.path, row.task.line, row.task.text, done);
      if (current()) {
        if (document.activeElement === previousFocus || document.activeElement === document.body)
          focusAfter.current = { key: `${row.path}:${row.task.line}`, index };
        setResult(null);
        setTick((value) => value + 1);
      }
    } catch (reason) {
      if (current()) {
        setError(errorMessage(reason));
        if (document.activeElement === previousFocus || document.activeElement === document.body)
          focusAfter.current = { key: `${row.path}:${row.task.line}`, index };
      }
    } finally {
      busy.current = false;
      if (current()) setPending(false);
    }
  }
  return (
    <DesignSystemScope as="main" className="task-query-view" aria-label={title}>
      <div ref={container}>
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        {kind === "query" && (
          <p className="task-query-expression">
            <code>{query}</code>
          </p>
        )}
        {error && (
          <Notice tone="error" role="alert">
            <strong>{loadError ? "Could not load this view" : "Could not update task"}</strong>
            <p>{error}</p>
            {loadError && (
              <Button
                ref={retry}
                variant="secondary"
                onClick={() => {
                  focusAfter.current = { key: "", index: 0 };
                  setTick((value) => value + 1);
                }}
              >
                Retry
              </Button>
            )}
          </Notice>
        )}
        {!query ? (
          <Notice>This saved view is unavailable.</Notice>
        ) : (
          !result &&
          !loadError && (
            <p className="mds-hint" role="status">
              Loading results…
            </p>
          )
        )}
        {pending && (
          <p className="mds-hint" role="status">
            Saving task…
          </p>
        )}
        {result && (
          <>
            <p className="mds-hint" role="status">
              {result.total} results{result.total > result.rows.length ? ` · showing ${result.rows.length}` : ""}
            </p>
            <ul className="task-query-results" aria-label="Query results">
              {result.rows.map((row, index) => (
                <li key={`${row.path}:${row.task?.line ?? index}`} className="task-query-row">
                  {row.task && (
                    <input
                      type="checkbox"
                      aria-label={row.task.text || "Empty task"}
                      data-task-key={`${row.path}:${row.task.line}`}
                      checked={row.task.status === "done"}
                      disabled={pending || !["open", "done"].includes(row.task.status)}
                      onChange={(event) => void toggle(row, event.target.checked, index)}
                    />
                  )}
                  <div className="task-query-content">
                    <span>{row.task?.text || row.title}</span>
                    <div className="task-query-meta">
                      <Button
                        onClick={() => {
                          if (current()) void useWorkspace.getState().open(row.path, { newTab: true });
                        }}
                      >
                        {row.title}
                      </Button>
                      {result.columns.map((column) => (
                        <span key={column}>
                          {column}: {cell(row, column)}
                        </span>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            {result.total === 0 && (
              <p className="mds-hint">No {query?.includes("task:") ? "tasks" : "notes"} match this view.</p>
            )}
          </>
        )}
      </div>
    </DesignSystemScope>
  );
}
