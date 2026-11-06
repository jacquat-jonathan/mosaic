import { dayStamp } from "../daily";
import { registerNotificationSource, type Notification, type NotificationSource } from "./registry";

/** Finished runs older than this stop being news. */
export const RECENT_RUN_SECONDS = 7 * 86_400;
/** A task is "close to its end date" when it is due within this many days (or already overdue). */
export const DUE_SOON_DAYS = 2;

const noteName = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/, "");

const reviewNeeded: NotificationSource = {
  kind: "review-needed",
  label: "Needs review",
  derive: ({ proposals }) =>
    proposals
      .filter((p) => p.status === "pending")
      .map(
        (p): Notification => ({
          id: `review-needed:${p.id}:${p.updated}`,
          kind: "review-needed",
          severity: "warning",
          title: `${noteName(p.path)} needs review`,
          detail: `${p.actor ?? "An agent"} ${p.action} this note.`,
          at: p.updated,
          target: { view: "activity" },
        }),
      ),
};

const workflowFinished: NotificationSource = {
  kind: "workflow-finished",
  label: "Workflow finished",
  derive: ({ runs, now }) =>
    runs
      .filter(
        (r) => r.status === "done" && r.finished != null && now.getTime() / 1000 - r.finished <= RECENT_RUN_SECONDS,
      )
      .map(
        (r): Notification => ({
          id: `workflow-finished:${r.id}`,
          kind: "workflow-finished",
          severity: "info",
          title: `${r.title || r.agent} finished`,
          detail: r.proposals ? `${r.proposals} ${r.proposals === 1 ? "change" : "changes"} proposed.` : undefined,
          at: (r.finished ?? r.started) * 1000,
          target: { view: "run", id: String(r.id) },
        }),
      ),
};

const workflowFailed: NotificationSource = {
  kind: "workflow-failed",
  label: "Workflow failed",
  derive: ({ runs, now }) =>
    runs
      .filter((r) => r.status === "failed" && now.getTime() / 1000 - (r.finished ?? r.started) <= RECENT_RUN_SECONDS)
      .map(
        (r): Notification => ({
          id: `workflow-failed:${r.id}`,
          kind: "workflow-failed",
          severity: "error",
          title: `${r.title || r.agent} failed`,
          detail: r.error ?? undefined,
          at: (r.finished ?? r.started) * 1000,
          target: { view: "run", id: String(r.id) },
        }),
      ),
};

const taskDueSoon: NotificationSource = {
  kind: "task-due-soon",
  label: "Task due soon",
  derive: ({ tasks, now }) => {
    const limit = dayStamp(new Date(now.getFullYear(), now.getMonth(), now.getDate() + DUE_SOON_DAYS));
    const today = dayStamp(now);
    return tasks
      .filter((t) => t.due_date && t.status !== "done" && !t.archived_at && !t.trashed_at && t.due_date <= limit)
      .map((t): Notification => {
        const due = t.due_date as string;
        const overdue = due < today;
        return {
          id: `task-due-soon:${t.id}:${due}`,
          kind: "task-due-soon",
          severity: overdue ? "error" : "warning",
          title: `${t.title} is ${overdue ? "overdue" : due === today ? "due today" : `due ${due}`}`,
          detail: overdue ? `Was due ${due}.` : undefined,
          // Deadlines have no event time; order by the due date so the most urgent sorts first.
          at: new Date(`${due}T00:00:00`).getTime(),
          target: { view: "tasks" },
        };
      });
  },
};

/** Registers the built-in sources. Idempotent. */
export function registerBuiltInSources() {
  for (const source of [reviewNeeded, workflowFinished, workflowFailed, taskDueSoon])
    registerNotificationSource(source);
}
