import { useEffect, useState } from "react";
import { api } from "../../ipc/api";
import { errorMessage, type PlannerActivityEntry } from "../../ipc/types";

export function ActivityTimeline({
  kind,
  id,
  revision,
  defaultOpen = false,
}: {
  kind: "epic" | "task" | "event";
  id: string;
  revision: number;
  defaultOpen?: boolean;
}) {
  const [entries, setEntries] = useState<PlannerActivityEntry[]>([]),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void api.plannerActivity(kind, id).then(
      (value) => {
        if (current) {
          setEntries(value);
          setError(null);
        }
      },
      (reason) => {
        if (current) setError(errorMessage(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [kind, id, revision]);
  return (
    <details className="planner-activity" open={defaultOpen || undefined}>
      <summary>
        Activity <span>{entries.length}</span>
      </summary>
      {error ? (
        <p className="error-text">{error}</p>
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
