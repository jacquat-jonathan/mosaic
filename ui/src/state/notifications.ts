import { vaultOperation } from "./vaultSession";
import { create } from "zustand";
import { api, onPlannerChanged } from "../ipc/api";
import type { PlannerTask } from "../ipc/types";
import { deriveNotifications, type Notification } from "../notifications/registry";
import { registerBuiltInSources } from "../notifications/sources";
import { useAttention } from "./attention";
import { useReview } from "./review";

registerBuiltInSources();

/** Read and dismissed notification ids, per vault. The notifications themselves are derived. */
interface Seen {
  read: string[];
  dismissed: string[];
}
const key = (root: string) => `mosaic:notifications:${root}`;
const MAX_IDS = 500;

export function loadSeen(root: string): Seen {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key(root)) ?? "{}");
    const ids = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === "string") : []);
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    return { read: ids(o.read), dismissed: ids(o.dismissed) };
  } catch {
    return { read: [], dismissed: [] };
  }
}

interface NotificationState {
  root: string | null;
  tasks: PlannerTask[];
  /** Everything currently derived, including dismissed and read items. */
  all: Notification[];
  read: Set<string>;
  dismissed: Set<string>;
  /** Not dismissed, newest first. */
  visible(): Notification[];
  unreadCount(): number;
  recompute(now?: Date): void;
  refreshTasks(): Promise<void>;
  markRead(ids: string[]): void;
  dismiss(ids: string[]): void;
  markAllRead(): void;
  dismissAll(): void;
}

export const useNotifications = create<NotificationState>((set, get) => {
  const persist = (read: Set<string>, dismissed: Set<string>) => {
    const root = get().root;
    // Bounded so storage can't grow forever; the oldest ids go first.
    const trim = (s: Set<string>) => [...s].slice(-MAX_IDS);
    if (root) {
      try {
        localStorage.setItem(key(root), JSON.stringify({ read: trim(read), dismissed: trim(dismissed) }));
      } catch {
        /* Still works for this session. */
      }
    }
    set({ read, dismissed });
  };
  return {
    root: null,
    tasks: [],
    all: [],
    read: new Set(),
    dismissed: new Set(),
    visible: () => get().all.filter((n) => !get().dismissed.has(n.id)),
    unreadCount: () =>
      get()
        .visible()
        .filter((n) => !get().read.has(n.id)).length,
    recompute(now = new Date()) {
      const all = deriveNotifications({
        now,
        proposals: useReview.getState().pending,
        runs: useAttention.getState().status?.runs ?? [],
        tasks: get().tasks,
      });
      const same = all.length === get().all.length && all.every((n, i) => n.id === get().all[i].id);
      set({ all: same ? get().all : all });
    },
    async refreshTasks() {
      const current = vaultOperation();
      const root = get().root;
      try {
        const tasks = await api.plannerTasks();
        if (get().root !== root || !current()) return;
        set({ tasks });
        get().recompute();
      } catch {
        /* No planner yet: task notifications stay empty. */
      }
    },
    markRead: (ids) => persist(new Set([...get().read, ...ids]), get().dismissed),
    dismiss: (ids) => persist(get().read, new Set([...get().dismissed, ...ids])),
    markAllRead: () =>
      get().markRead(
        get()
          .visible()
          .map((n) => n.id),
      ),
    dismissAll: () =>
      get().dismiss(
        get()
          .visible()
          .map((n) => n.id),
      ),
  };
});

/** Starts deriving notifications for a vault; returns a function that stops. */
export function startNotifications(root: string) {
  const seen = loadSeen(root);
  useNotifications.setState({
    root,
    tasks: [],
    all: [],
    read: new Set(seen.read),
    dismissed: new Set(seen.dismissed),
  });
  const recompute = () => useNotifications.getState().recompute();
  const refreshTasks = () => void useNotifications.getState().refreshTasks();
  const offs = [useReview.subscribe(recompute), useAttention.subscribe(recompute)];
  recompute();
  refreshTasks();
  let live = true;
  void onPlannerChanged(refreshTasks).then((off) => (live ? offs.push(off) : off()));
  window.addEventListener("focus", refreshTasks);
  // Deadlines approach with the clock, not with an event.
  const timer = setInterval(refreshTasks, 15 * 60_000);
  return () => {
    live = false;
    clearInterval(timer);
    window.removeEventListener("focus", refreshTasks);
    for (const off of offs) off();
  };
}
