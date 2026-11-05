import { useEffect, useRef, useState } from "react";
import { Button, Notice } from "../../design-system/components";
import { api } from "../../ipc/api";
import { errorMessage, type PlannerActivityEntry } from "../../ipc/types";

export function ActivityTimeline({
  kind,
  id,
  revision,
  defaultOpen = false,
  designSystem = false,
}: {
  kind: "epic" | "task" | "event";
  id: string;
  revision: number;
  defaultOpen?: boolean;
  designSystem?: boolean;
}) {
  const [entries, setEntries] = useState<PlannerActivityEntry[]>([]),
    [error, setError] = useState<string | null>(null);
  const summary = useRef<HTMLElement>(null),
    retryFocus = useRef(false);
  const [loading, setLoading] = useState(true),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!loading && retryFocus.current) {
      summary.current?.focus();
      retryFocus.current = false;
    }
  }, [loading]);
  useEffect(() => {
    setLoading(true);
    setEntries([]);
    setError(null);
    let current = true;
    void api.plannerActivity(kind, id).then(
      (value) => {
        if (current) {
          setEntries(value);
          setError(null);
          setLoading(false);
        }
      },
      (reason) => {
        if (current) {
          setError(errorMessage(reason));
          setLoading(false);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [kind, id, revision, attempt]);
  return (
    <details className="planner-activity" open={defaultOpen || undefined}>
      <summary ref={summary}>
        Activity <span>{entries.length}</span>
      </summary>
      {error ? (
        designSystem ? (
          <Notice tone="error">
            {error}
            <Button
              onClick={() => {
                retryFocus.current = true;
                setAttempt((value) => value + 1);
              }}
            >
              Retry activity
            </Button>
          </Notice>
        ) : (
          <p className="error-text">{error}</p>
        )
      ) : designSystem && loading ? (
        <p className="mds-hint" role="status">
          Loading activity…
        </p>
      ) : designSystem && !entries.length ? (
        <p className="mds-hint">No activity yet.</p>
      ) : (
        <ol>
          {[...entries].reverse().map((entry) => (
            <li key={entry.id}>
              <span>{entry.summary}</span>
              <time dateTime={entry.occurred_at}>{new Date(entry.occurred_at).toLocaleString()}</time>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
