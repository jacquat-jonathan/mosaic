// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CalendarOverlayOccurrence,
  EventOccurrence,
  IcalImportPreview,
  PlannerCalendarRange,
  PlannerEvent,
  PlannerTask,
  PlannerWorkSession,
} from "../../ipc/types";
import { api } from "../../ipc/api";
import { useSettings } from "../../state/settings";
import { useVault } from "../../state/vault";

const childProps = vi.hoisted(() => ({
  month: null as object | null,
  week: null as object | null,
  eventEditor: null as object | null,
  sessionEditor: null as object | null,
  overlay: null as object | null,
  importWizard: null as object | null,
  sources: null as object | null,
  archives: null as object | null,
  tray: null as object | null,
}));

vi.mock("./MonthView", () => ({
  MonthView: (props: object) => {
    childProps.month = props;
    return <div data-testid="month-view" />;
  },
}));
vi.mock("./WeekView", () => ({
  WeekView: (props: object) => {
    childProps.week = props;
    return <div data-testid="week-view" />;
  },
}));
vi.mock("./EventEditor", () => ({
  EventEditor: (props: object) => {
    childProps.eventEditor = props;
    return <div data-testid="event-editor" />;
  },
}));
vi.mock("./WorkSessionEditor", () => ({
  WorkSessionEditor: (props: object) => {
    childProps.sessionEditor = props;
    return <div data-testid="session-editor" />;
  },
}));
vi.mock("./OverlayDetails", () => ({
  OverlayDetails: (props: object) => {
    childProps.overlay = props;
    return <div data-testid="overlay-details" />;
  },
}));
vi.mock("./IcalImportWizard", () => ({
  IcalImportWizard: (props: object) => {
    childProps.importWizard = props;
    return <div data-testid="import-wizard" />;
  },
}));
vi.mock("./CalendarSourcesDialog", () => ({
  CalendarSourcesDialog: (props: object) => {
    childProps.sources = props;
    return <div data-testid="sources-dialog" />;
  },
}));
vi.mock("./EventArchiveDialog", () => ({
  EventArchiveDialog: (props: object) => {
    childProps.archives = props;
    return <div data-testid="archives-dialog" />;
  },
}));
vi.mock("./UnscheduledTray", () => ({
  UnscheduledTray: (props: object) => {
    childProps.tray = props;
    return <div data-testid="unscheduled-tray" />;
  },
}));

import { CalendarView } from "./CalendarView";

const invoke = (props: object | null, name: string, ...args: unknown[]) => {
  const callback = (props as Record<string, (...values: unknown[]) => unknown>)[name];
  return callback(...args);
};

const event = (overrides: Partial<EventOccurrence> = {}): EventOccurrence => ({
  event_id: "event-1",
  series_id: "series-1",
  occurrence_key: "2026-10-28",
  title: "Planning",
  description: "Discuss",
  location: "Room",
  meeting_url: null,
  participants: ["Sam"],
  epic_id: null,
  color: "#123456",
  all_day: false,
  start_value: "2026-10-28T09:00:00.000Z",
  end_value: "2026-10-28T10:00:00.000Z",
  timezone: "UTC",
  recurring: false,
  ...overrides,
});

const series = (id = "series-1", overrides: Partial<PlannerEvent> = {}): PlannerEvent => ({
  id,
  series_id: null,
  title: "Planning",
  description: "Discuss",
  location: "Room",
  meeting_url: null,
  participants: ["Sam"],
  epic_id: null,
  color: "#123456",
  all_day: false,
  start_value: "2026-10-28T09:00:00.000Z",
  end_value: "2026-10-28T10:00:00.000Z",
  timezone: "UTC",
  recurrence_rule: null,
  revision: 1,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  archived_at: null,
  trashed_at: null,
  ...overrides,
});

const session = (overrides: Partial<PlannerWorkSession> = {}): PlannerWorkSession => ({
  id: "session-1",
  task_id: "task-1",
  all_day: false,
  start_value: "2026-10-28T09:30:00.000Z",
  end_value: "2026-10-28T11:00:00.000Z",
  timezone: "UTC",
  state: "planned",
  revision: 1,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const task: PlannerTask = {
  id: "task-1",
  epic_id: null,
  parent_id: null,
  title: "Write tests",
  description: "",
  status: "new",
  due_date: null,
  estimate_minutes: 60,
  position: 1024,
  revision: 1,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  completed_at: null,
  archived_at: null,
  trashed_at: null,
};

const external: CalendarOverlayOccurrence = {
  source_id: "source-1",
  source_name: "External",
  uid: "uid-1",
  title: "External meeting",
  description: "Imported",
  location: "Elsewhere",
  meeting_url: null,
  all_day: false,
  start_value: "2026-10-28T12:00:00.000Z",
  end_value: "2026-10-28T13:00:00.000Z",
  timezone: "UTC",
  occurrence_key: "2026-10-28",
  color: "#abcdef",
  read_only: true,
};

const calendarRange: PlannerCalendarRange = {
  from: "2026-10-01",
  to: "2026-10-31",
  events: [
    event(),
    event({ event_id: "recurring", series_id: "series-recurring", recurring: true }),
    event({
      event_id: "all-day",
      series_id: "series-all-day",
      all_day: true,
      start_value: "2026-10-28",
      end_value: "2026-10-30",
    }),
  ],
  work_sessions: [
    { session: session(), task_title: task.title, task_status: task.status, epic_id: null, color: null },
    {
      session: session({ id: "all-session", all_day: true, start_value: "2026-10-28", end_value: "2026-10-30" }),
      task_title: "All day",
      task_status: "new",
      epic_id: null,
      color: null,
    },
  ],
  due_markers: [],
  unscheduled_tasks: [task],
  workload: [],
};

const icalPreview: IcalImportPreview = {
  planner_revision: 1,
  source_kind: "ics-file",
  candidates: [],
  duplicates: 0,
};

beforeEach(() => {
  localStorage.clear();
  childProps.month = null;
  childProps.week = null;
  useVault.setState({ vault: { root: "/vault", name: "Vault" } });
  useSettings.setState({ weekStart: "monday" });
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:calendar"), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.spyOn(api, "plannerCalendarRange").mockResolvedValue(calendarRange);
  vi.spyOn(api, "calendarOverlayRange").mockResolvedValue({
    subscriptions: [
      {
        id: "sub-1",
        name: "Team",
        color: "#f00",
        visible: true,
        refresh_minutes: 15,
        last_success: null,
        last_error: null,
        has_cache: true,
      },
    ],
    occurrences: [external],
  });
  vi.spyOn(api, "plannerEpics").mockResolvedValue([]);
  vi.spyOn(api, "plannerEvents").mockResolvedValue([
    series(),
    series("series-recurring", { recurrence_rule: "FREQ=DAILY" }),
    series("series-all-day", { all_day: true, start_value: "2026-10-28", end_value: "2026-10-30" }),
  ]);
  vi.spyOn(api, "refreshCalendarSubscriptions").mockResolvedValue([]);
  vi.spyOn(api, "updateCalendarSubscription").mockResolvedValue({
    id: "sub-1",
    name: "Team",
    color: "#f00",
    visible: false,
    refresh_minutes: 15,
    last_success: null,
    last_error: null,
    has_cache: true,
  });
  vi.spyOn(api, "createPlannerWorkSession").mockResolvedValue(session());
  vi.spyOn(api, "updatePlannerWorkSession").mockResolvedValue(session({ revision: 2 }));
  vi.spyOn(api, "cancelPlannerWorkSession").mockResolvedValue(session({ state: "cancelled", revision: 2 }));
  vi.spyOn(api, "updatePlannerEvent").mockResolvedValue(series("series-1", { revision: 2 }));
  vi.spyOn(api, "replacePlannerEventOccurrence").mockResolvedValue(series("series-recurring", { revision: 2 }));
  vi.spyOn(api, "cancelPlannerEventOccurrence").mockResolvedValue(series("series-recurring", { revision: 2 }));
  vi.spyOn(api, "archivePlannerEvent").mockResolvedValue(series("series-1", { archived_at: "now", revision: 2 }));
  vi.spyOn(api, "trashPlannerEvent").mockResolvedValue(
    series("series-1", { archived_at: "now", trashed_at: "now", revision: 3 }),
  );
  vi.spyOn(api, "createPlannerEvent").mockResolvedValue(series("imported"));
  vi.spyOn(api, "previewPlannerIcal").mockResolvedValue(icalPreview);
  vi.spyOn(api, "exportPlannerIcal").mockResolvedValue("BEGIN:VCALENDAR\nEND:VCALENDAR");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("planner calendar container", () => {
  it("loads, navigates, filters and opens each calendar panel", async () => {
    render(<CalendarView initialMode="month" />);
    await screen.findByTestId("month-view");
    await waitFor(() => expect(api.plannerCalendarRange).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Previous period" }));
    fireEvent.click(screen.getByRole("button", { name: "Next period" }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    fireEvent.click(screen.getByLabelText("Local events"));
    fireEvent.click(screen.getByLabelText("Work sessions"));
    fireEvent.click(screen.getByLabelText("Due dates"));
    fireEvent.click(screen.getByLabelText("Team 🔒"));
    await waitFor(() =>
      expect(api.updateCalendarSubscription).toHaveBeenCalledWith("sub-1", "Team", "#f00", false, 15),
    );

    fireEvent.click(screen.getByRole("button", { name: "Archived local events…" }));
    expect(screen.getByTestId("archives-dialog")).toBeTruthy();
    await act(async () => invoke(childProps.archives, "onChange"));
    act(() => invoke(childProps.archives, "onClose"));
    fireEvent.click(screen.getByRole("button", { name: "Manage subscriptions…" }));
    await act(async () => invoke(childProps.sources, "onChange"));
    act(() => invoke(childProps.sources, "onClose"));

    fireEvent.click(screen.getByRole("button", { name: "New event" }));
    expect(screen.getByTestId("event-editor")).toBeTruthy();
    act(() => invoke(childProps.eventEditor, "onClose"));
    fireEvent.click(screen.getByRole("button", { name: "New event" }));
    act(() => invoke(childProps.eventEditor, "onDone"));

    act(() => invoke(childProps.month, "onDay", "2026-10-28"));
    expect(await screen.findByTestId("week-view")).toBeTruthy();
    expect(localStorage.getItem("mosaic:planner-calendar-mode")).toBe("day");
  });

  it("executes week event, session, task and overlay interactions", async () => {
    render(<CalendarView initialMode="week" />);
    await screen.findByTestId("week-view");
    const timed = calendarRange.events[0],
      recurring = calendarRange.events[1],
      allDay = calendarRange.events[2],
      timedSession = calendarRange.work_sessions[0].session,
      allDaySession = calendarRange.work_sessions[1].session;

    act(() => invoke(childProps.week, "onEvent", timed.series_id, timed.occurrence_key));
    expect(screen.getByTestId("event-editor")).toBeTruthy();
    act(() => invoke(childProps.week, "onEmptyRange", "2026-10-29", 8.5, 10));
    act(() => invoke(childProps.week, "onEventResizePreview", timed, 30));
    act(() => invoke(childProps.week, "onEventResizePreview", allDay, 30));
    await act(async () => invoke(childProps.week, "onEventResize", timed, 30));
    await waitFor(() => expect(api.updatePlannerEvent).toHaveBeenCalled());
    await act(async () => invoke(childProps.week, "onEventResize", recurring, -30));
    await waitFor(() => expect(api.replacePlannerEventOccurrence).toHaveBeenCalled());
    act(() => invoke(childProps.week, "onEventResize", timed, 0));

    await act(async () => invoke(childProps.week, "onEventMove", timed, "2026-10-30", 14));
    await act(async () => invoke(childProps.week, "onEventMove", recurring, "2026-10-30", null));
    await act(async () => invoke(childProps.week, "onEventMove", allDay, "2026-10-30"));
    await waitFor(() => expect(api.updatePlannerEvent).toHaveBeenCalled());

    act(() => invoke(childProps.week, "onSession", timedSession));
    expect(screen.getByTestId("session-editor")).toBeTruthy();
    act(() => invoke(childProps.sessionEditor, "onReload"));
    act(() => invoke(childProps.sessionEditor, "onClose"));
    act(() => invoke(childProps.week, "onSession", timedSession));
    act(() => invoke(childProps.sessionEditor, "onDone"));
    act(() => invoke(childProps.week, "onSessionResizeStart"));
    act(() => invoke(childProps.week, "onSessionResize", timedSession, -1000));
    act(() => invoke(childProps.week, "onSessionResize", allDaySession, 30));
    act(() => invoke(childProps.week, "onSessionMove", timedSession, "2026-10-30", 11));
    act(() => invoke(childProps.week, "onSessionMove", allDaySession, "2026-10-30", null));
    act(() => invoke(childProps.week, "onSessionCancel", timedSession));
    await waitFor(() => expect(api.cancelPlannerWorkSession).toHaveBeenCalled());

    act(() => invoke(childProps.week, "onTaskDrop", task.id, "2026-10-30", null));
    act(() => invoke(childProps.week, "onTaskDrop", task.id, "2026-10-30", 13));
    act(() => invoke(childProps.week, "onTaskDrop", "missing", "2026-10-30", 13));
    act(() => invoke(childProps.tray, "onSchedule", task));
    await waitFor(() => expect(api.createPlannerWorkSession).toHaveBeenCalled());

    act(() => invoke(childProps.week, "onOverlay", external));
    expect(screen.getByTestId("overlay-details")).toBeTruthy();
    act(() => invoke(childProps.overlay, "onClose"));
    act(() => invoke(childProps.week, "onOverlay", external));
    await act(async () => invoke(childProps.overlay, "onImport"));
    await waitFor(() => expect(api.createPlannerEvent).toHaveBeenCalled());

    act(() => invoke(childProps.week, "onEventDelete", recurring));
    await waitFor(() => expect(api.cancelPlannerEventOccurrence).toHaveBeenCalled());
    act(() => invoke(childProps.week, "onEventDelete", timed));
    await waitFor(() => expect(api.trashPlannerEvent).toHaveBeenCalled());
  });

  it("imports, exports and reports calendar operation failures", async () => {
    render(<CalendarView initialMode="week" />);
    await screen.findByTestId("week-view");
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["BEGIN:VCALENDAR"], "plan.ics", { type: "text/calendar" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue("BEGIN:VCALENDAR") });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByTestId("import-wizard")).toBeTruthy();
    act(() => invoke(childProps.importWizard, "onCancel"));
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByTestId("import-wizard");
    act(() => invoke(childProps.importWizard, "onDone"));

    fireEvent.click(screen.getByRole("button", { name: "Export iCalendar file" }));
    await waitFor(() => expect(api.exportPlannerIcal).toHaveBeenCalled());
    expect(URL.createObjectURL).toHaveBeenCalled();

    const tooLarge = new File(["x"], "huge.ics");
    Object.defineProperty(tooLarge, "size", { value: 11 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [tooLarge] } });
    expect(await screen.findByText("iCalendar files must be 10 MB or smaller")).toBeTruthy();

    vi.mocked(api.refreshCalendarSubscriptions).mockRejectedValueOnce(new Error("refresh failed"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh calendar" }));
    expect(await screen.findByText("refresh failed")).toBeTruthy();
  });
  it("day failures remain explicit and can be retried", async () => {
    vi.mocked(api.plannerCalendarRange).mockRejectedValue(new Error("calendar offline"));
    render(<CalendarView initialMode="day" />);
    expect(await screen.findByText("calendar offline")).toBeTruthy();
    vi.mocked(api.plannerCalendarRange).mockResolvedValue(calendarRange);
    fireEvent.click(screen.getByRole("button", { name: "Retry calendar" }));
    await waitFor(() => expect(screen.queryByText("calendar offline")).toBeNull());
  });
});
