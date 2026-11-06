import type { AgentRun, PlannerTask, Proposal } from "../ipc/types";

export type NotificationSeverity = "info" | "warning" | "error";

/** Where opening a notification goes: a workspace view (`openView(kind, id)`). */
export interface NotificationTarget {
  view: string;
  id?: string;
}

export interface Notification {
  /** Stable and derived from the subject, so read/dismissed state survives re-derivation. */
  id: string;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  detail?: string;
  /** Milliseconds since the epoch: when it happened (or, for deadlines, when it was derived). */
  at: number;
  target: NotificationTarget;
}

/** Everything sources may look at. Sources are pure functions of this snapshot. */
export interface NotificationSnapshot {
  now: Date;
  proposals: Proposal[];
  runs: AgentRun[];
  tasks: PlannerTask[];
}

/** A typed producer of one kind of notification. Register one to add a new notification type. */
export interface NotificationSource {
  kind: string;
  /** Human name of the type, shown in the list. */
  label: string;
  derive(snapshot: NotificationSnapshot): Notification[];
}

const sources = new Map<string, NotificationSource>();

/** Adds (or replaces, by `kind`) a source. Returns a function that removes it. */
export function registerNotificationSource(source: NotificationSource): () => void {
  sources.set(source.kind, source);
  return () => {
    if (sources.get(source.kind) === source) sources.delete(source.kind);
  };
}

export const notificationSources = (): NotificationSource[] => [...sources.values()];
export const notificationLabel = (kind: string) => sources.get(kind)?.label ?? kind;

/** Runs every source; a source that throws is skipped so one bad source can't hide the rest. */
export function deriveNotifications(snapshot: NotificationSnapshot): Notification[] {
  const out = new Map<string, Notification>();
  for (const source of sources.values()) {
    try {
      for (const n of source.derive(snapshot)) out.set(n.id, n);
    } catch {
      /* skipped */
    }
  }
  return [...out.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}
