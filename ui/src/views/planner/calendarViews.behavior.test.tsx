// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CalendarOverlayOccurrence,
  CalendarWorkSession,
  EventOccurrence,
  PlannerCalendarRange,
  PlannerWorkSession,
} from "../../ipc/types";
import { EVENT_DRAG, SESSION_DRAG } from "./calendarModel";
import { MonthView } from "./MonthView";
import { TASK_DRAG } from "./UnscheduledTray";
import { WeekView } from "./WeekView";

const event = (overrides: Partial<EventOccurrence> = {}): EventOccurrence => ({
  event_id: "event-1",
  series_id: "series-1",
  occurrence_key: "2026-10-28",
  title: "Planning",
  description: "",
  location: "",
  meeting_url: null,
  participants: [],
  epic_id: null,
  color: null,
  all_day: false,
  start_value: "2026-10-28T09:00:00.000Z",
  end_value: "2026-10-28T10:00:00.000Z",
  timezone: "UTC",
  recurring: true,
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

const work = (overrides: Partial<CalendarWorkSession> = {}): CalendarWorkSession => ({
  session: session(),
  task_title: "Write tests",
  task_status: "in-progress",
  epic_id: null,
  color: null,
  ...overrides,
});

const overlay = (overrides: Partial<CalendarOverlayOccurrence> = {}): CalendarOverlayOccurrence => ({
  source_id: "source-1",
  source_name: "External",
  uid: "uid-1",
  title: "Read only",
  description: "",
  location: "",
  meeting_url: null,
  all_day: false,
  start_value: "2026-10-28T12:00:00.000Z",
  end_value: "2026-10-28T13:00:00.000Z",
  timezone: "UTC",
  occurrence_key: "2026-10-28",
  color: null,
  read_only: true,
  ...overrides,
});

const range = (): PlannerCalendarRange => ({
  from: "2026-10-27",
  to: "2026-10-29",
  events: [
    event(),
    event({ event_id: "event-2", series_id: "series-2", title: "Second", color: "#f00" }),
    event({
      event_id: "all-event",
      series_id: "all-series",
      occurrence_key: "2026-10-28",
      title: "All day",
      all_day: true,
      start_value: "2026-10-28",
      end_value: "2026-10-30",
    }),
  ],
  work_sessions: [
    work(),
    work({
      session: session({ id: "all-session", all_day: true, start_value: "2026-10-28", end_value: "2026-10-29" }),
      task_title: "All day work",
      task_status: "new",
      color: "#0a0",
    }),
  ],
  due_markers: [{ task_id: "due-1", title: "Due", date: "2026-10-28", status: "new", epic_id: null, color: null }],
  unscheduled_tasks: [],
  workload: [{ date: "2026-10-28", minutes: 90 }],
});

const transfer = () => ({
  values: new Map<string, string>(),
  effectAllowed: "",
  setData(type: string, value: string) {
    this.values.set(type, value);
  },
  getData(type: string) {
    return this.values.get(type) ?? "";
  },
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Element.prototype.setPointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("month calendar", () => {
  const props = () => ({
    days: [new Date("2026-09-30T12:00:00"), new Date("2026-10-28T12:00:00"), new Date("2026-10-29T12:00:00")],
    anchor: new Date("2026-10-01T12:00:00"),
    data: range(),
    overlays: [
      overlay(),
      overlay({
        uid: "all-overlay",
        title: "External all day",
        all_day: true,
        start_value: "2026-10-28",
        end_value: "2026-10-29",
      }),
    ],
    today: "2026-10-28",
    show: { events: true, sessions: true, due: true },
    onDay: vi.fn(),
    onEvent: vi.fn(),
    onSession: vi.fn(),
    onOverlay: vi.fn(),
    onEventMove: vi.fn(),
    onSessionMove: vi.fn(),
    onEventDelete: vi.fn(),
    onSessionDelete: vi.fn(),
  });

  it("renders mixed entries, workload, overflow and all activation paths", () => {
    const p = props();
    render(<MonthView {...p} />);
    expect(screen.getByTitle("90 planned minutes").textContent).toBe("1.5h");
    expect(screen.getByText(/Due/)).toBeTruthy();
    expect(screen.getByText(/more/)).toBeTruthy();
    cleanup();
    p.data = { ...range(), events: [event()], work_sessions: [work()] };
    p.overlays = [overlay()];
    render(<MonthView {...p} />);
    const cells = screen.getAllByRole("gridcell");
    expect(cells[0].className).toContain("other-month");
    expect(cells[1].className).toContain("today");
    fireEvent.click(cells[1]);
    fireEvent.keyDown(cells[1], { key: "Enter" });
    fireEvent.keyDown(cells[1], { key: " " });
    fireEvent.keyDown(cells[1], { key: "Escape" });
    expect(p.onDay).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole("button", { name: "Planning" }));
    fireEvent.click(screen.getByRole("button", { name: "Read only" }));
    const sessionChip = screen.getByRole("button", { name: /Write tests/ });
    fireEvent.click(sessionChip);
    fireEvent.keyDown(sessionChip, { key: "Enter" });
    fireEvent.keyDown(sessionChip, { key: " " });
    fireEvent.keyDown(sessionChip, { key: "Escape" });
    expect(p.onEvent).toHaveBeenCalledWith("series-1", "2026-10-28");
    expect(p.onOverlay).toHaveBeenCalled();
    expect(p.onSession).toHaveBeenCalledTimes(3);
  });

  it("drags events and sessions, ignores malformed drops and deletes from context menus", async () => {
    const p = props();
    p.data = { ...range(), events: [event()], work_sessions: [work()] };
    p.overlays = [overlay()];
    render(<MonthView {...p} />);
    const cells = screen.getAllByRole("gridcell");
    const eventButton = screen.getByRole("button", { name: "Planning" });
    const eventTransfer = transfer();
    fireEvent.dragStart(eventButton, { dataTransfer: eventTransfer });
    fireEvent.dragOver(cells[2], { dataTransfer: eventTransfer });
    expect(document.querySelector(".planner-month-drop-preview")).toBeTruthy();
    fireEvent.drop(cells[2], { dataTransfer: eventTransfer });
    expect(p.onEventMove).toHaveBeenCalledWith(expect.objectContaining({ series_id: "series-1" }), "2026-10-29");
    fireEvent.dragEnd(eventButton, { dataTransfer: eventTransfer });

    const sessionChip = screen.getByRole("button", { name: /Write tests/ });
    const sessionTransfer = transfer();
    fireEvent.dragStart(sessionChip, { dataTransfer: sessionTransfer });
    fireEvent.drop(cells[2], { dataTransfer: sessionTransfer });
    expect(p.onSessionMove).toHaveBeenCalledWith(expect.objectContaining({ id: "session-1" }), "2026-10-29");
    fireEvent.dragEnd(sessionChip, { dataTransfer: sessionTransfer });

    const bad = transfer();
    bad.setData(EVENT_DRAG, "not json");
    fireEvent.drop(cells[2], { dataTransfer: bad });
    bad.values.set(EVENT_DRAG, JSON.stringify({ seriesId: "missing", occurrenceKey: "missing" }));
    fireEvent.drop(cells[2], { dataTransfer: bad });

    fireEvent.contextMenu(eventButton, { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(p.onEventDelete).toHaveBeenCalled();
    fireEvent.contextMenu(sessionChip, { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(p.onSessionDelete).toHaveBeenCalled();
    fireEvent.contextMenu(sessionChip);
    fireEvent.click(screen.getByRole("menu"));
    window.dispatchEvent(new Event("blur"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("hides optional internal event, session and due layers", () => {
    const p = props();
    const { rerender } = render(<MonthView {...p} show={{ events: false, sessions: false, due: false }} />);
    expect(screen.queryByText("Planning")).toBeNull();
    expect(screen.queryByText(/Write tests/)).toBeNull();
    expect(screen.queryByText("Due")).toBeNull();
    rerender(<MonthView {...p} overlays={[]} data={{ ...range(), workload: [] }} />);
  });
});

describe("week calendar", () => {
  const props = () => ({
    days: [new Date("2026-10-28T12:00:00"), new Date("2026-10-29T12:00:00")],
    data: range(),
    overlays: [
      overlay(),
      overlay({
        uid: "all-overlay",
        title: "External all day",
        all_day: true,
        start_value: "2026-10-28",
        end_value: "2026-10-29",
      }),
    ],
    today: "2026-10-28",
    show: { events: true, sessions: true, due: true },
    selectedRange: { day: "2026-10-28", startHour: 8, endHour: 10 },
    onEvent: vi.fn(),
    onSession: vi.fn(),
    onOverlay: vi.fn(),
    onEmptyRange: vi.fn(),
    onTaskDrop: vi.fn(),
    onSessionMove: vi.fn(),
    onEventMove: vi.fn(),
    onEventResizePreview: vi.fn(),
    onEventResize: vi.fn(),
    onSessionResizeStart: vi.fn(),
    onSessionResize: vi.fn(),
    onEventDelete: vi.fn(),
    onSessionCancel: vi.fn(),
  });

  it("renders all-day and timed kinds and activates cards with mouse and keyboard", () => {
    const p = props();
    render(<WeekView {...p} />);
    expect(screen.getByText(/Due/)).toBeTruthy();
    expect(screen.getAllByText("All day").length).toBeGreaterThan(0);
    const planning = screen.getByText("Planning").closest("[role=button]")!;
    fireEvent.click(planning);
    fireEvent.keyDown(planning, { key: "Enter" });
    fireEvent.keyDown(planning, { key: " " });
    fireEvent.keyDown(planning, { key: "Escape" });
    const external = screen.getByText("Read only").closest("button")!;
    fireEvent.click(external);
    const timedSession = screen.getByText(/90 min/).closest("[role=button]")!;
    fireEvent.click(timedSession);
    fireEvent.keyDown(timedSession, { key: "Enter" });
    fireEvent.keyDown(timedSession, { key: " " });
    expect(p.onEvent).toHaveBeenCalledTimes(3);
    expect(p.onOverlay).toHaveBeenCalled();
    expect(p.onSession).toHaveBeenCalledTimes(3);
  });

  it("selects empty ranges, handles all drop formats and displays previews", () => {
    const p = props();
    render(<WeekView {...p} />);
    const hours = screen.getAllByLabelText(/Create event 2026-10-28/);
    const first = hours[0];
    const second = hours[1];
    fireEvent.mouseDown(first, { button: 0 });
    fireEvent.mouseEnter(second, { buttons: 1 });
    fireEvent.mouseUp(second);
    expect(p.onEmptyRange).toHaveBeenCalled();
    fireEvent.mouseDown(first, { button: 1 });
    fireEvent.mouseUp(first);

    const allDayCells = document.querySelectorAll(".planner-all-day-cell");
    const taskTransfer = transfer();
    taskTransfer.setData(TASK_DRAG, "task-1");
    fireEvent.dragOver(allDayCells[1], { dataTransfer: taskTransfer });
    expect(document.querySelector(".planner-all-day-drop-preview")).toBeTruthy();
    fireEvent.drop(allDayCells[1], { dataTransfer: taskTransfer });
    expect(p.onTaskDrop).toHaveBeenCalledWith("task-1", "2026-10-29", null);

    const timeDay = document.querySelectorAll(".planner-time-day")[1];
    Object.defineProperty(timeDay, "getBoundingClientRect", { value: () => new DOMRect(0, 0, 100, 600) });
    const sessionTransfer = transfer();
    sessionTransfer.setData(SESSION_DRAG, "session-1");
    fireEvent.dragOver(timeDay, { dataTransfer: sessionTransfer, clientY: 40 });
    fireEvent.drop(timeDay, { dataTransfer: sessionTransfer, clientY: 40 });
    expect(p.onSessionMove).toHaveBeenCalled();
    const eventTransfer = transfer();
    eventTransfer.setData(EVENT_DRAG, JSON.stringify({ seriesId: "series-1", occurrenceKey: "2026-10-28" }));
    fireEvent.drop(timeDay, { dataTransfer: eventTransfer, clientY: 900 });
    expect(p.onEventMove).toHaveBeenCalled();
    eventTransfer.values.set(EVENT_DRAG, "bad");
    fireEvent.drop(timeDay, { dataTransfer: eventTransfer, clientY: -100 });
    window.dispatchEvent(new Event("dragend"));
  });

  it("drags cards, opens context menus and resizes events and sessions in keyboard steps", () => {
    const p = props();
    render(<WeekView {...p} />);
    const planning = screen.getByText("Planning").closest("[role=button]")!;
    const eventTransfer = transfer();
    fireEvent.dragStart(planning, { dataTransfer: eventTransfer });
    expect(eventTransfer.values.get(EVENT_DRAG)).toContain("series-1");
    fireEvent.contextMenu(planning, { clientX: 4, clientY: 5 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(p.onEventDelete).toHaveBeenCalled();

    const eventResize = screen.getByLabelText(/Resize Planning/);
    fireEvent.keyDown(eventResize, { key: "ArrowUp" });
    fireEvent.keyDown(eventResize, { key: "ArrowDown" });
    fireEvent.keyDown(eventResize, { key: "Enter" });
    expect(p.onEventResize).toHaveBeenCalledWith(expect.anything(), -15);
    expect(p.onEventResize).toHaveBeenCalledWith(expect.anything(), 15);

    const timedSession = screen.getByText(/90 min/).closest("[role=button]")!;
    const sessionTransfer = transfer();
    fireEvent.dragStart(timedSession, { dataTransfer: sessionTransfer });
    expect(sessionTransfer.values.get(SESSION_DRAG)).toBe("session-1");
    fireEvent.contextMenu(timedSession);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(p.onSessionCancel).toHaveBeenCalled();
    const sessionResize = screen.getByLabelText(/Resize Write tests/);
    fireEvent.keyDown(sessionResize, { key: "ArrowDown" });
    expect(p.onSessionResizeStart).toHaveBeenCalled();
    expect(p.onSessionResize).toHaveBeenCalledWith(expect.anything(), 15);
    window.dispatchEvent(new Event("click"));
    window.dispatchEvent(new Event("blur"));
  });

  it("covers disabled layers and selected-range clearing", () => {
    const p = props();
    const { rerender } = render(
      <WeekView {...p} show={{ events: false, sessions: false, due: false }} selectedRange={null} />,
    );
    expect(screen.queryByText("Planning")).toBeNull();
    expect(screen.queryByText(/Write tests/)).toBeNull();
    rerender(<WeekView {...p} selectedRange={{ day: "2026-10-28", startHour: 9, endHour: 10 }} />);
    fireEvent.mouseDown(document.body);
    window.dispatchEvent(new Event("mouseup"));
  });
});
