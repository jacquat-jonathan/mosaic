// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IcalImportPreview,
  MarkdownImportPreview,
  PlannerEpic,
  PlannerEvent,
  PlannerTask,
  PlannerWorkSession,
  TemplatePreview,
} from "./types";
import { mockCommands, mockInvoke, mockPropose } from "./mock";

// Seed the mock's relative daily notes before import so fixed-format fixtures stay deterministic.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
});

const invoke = <T>(cmd: string, args: Record<string, unknown> = {}) => mockInvoke(cmd, args) as Promise<T>;
const rejects = (cmd: string, args: Record<string, unknown>, code: string) =>
  expect(mockInvoke(cmd, args)).rejects.toMatchObject({ code });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("browser mock file and query behavior", () => {
  it("validates paths and exercises create, copy, import, list, read and delete operations", async () => {
    expect(await mockCommands.currentVault()).toBeNull();
    await invoke("open_vault", { path: "/mock/coverage" });
    expect(await mockCommands.currentVault()).toMatchObject({ root: "/mock/coverage" });
    expect(await mockCommands.lastVault()).toBeNull();
    expect(await mockCommands.recentVaults()).toHaveLength(3);
    await mockCommands.forgetVault("unused");

    await rejects("create_file", { path: "/absolute.md", content: "", root: null }, "invalid_path");
    await rejects("create_file", { path: "a/../escape.md", content: "", root: null }, "invalid_path");
    await rejects("create_file", { path: ".hidden/note.md", content: "", root: null }, "invalid_path");
    await rejects("create_file", { path: "wrong.md", content: "", root: "/another" }, "invalid");

    await invoke("make_dir", { path: "Coverage/Nested" });
    await invoke("create_file", { path: "Coverage/Nested/a.md", content: "Alpha #one", root: "/mock/coverage" });
    await rejects(
      "create_file",
      { path: "Coverage/Nested/a.md", content: "duplicate", root: "/mock/coverage" },
      "already_exists",
    );
    await invoke("copy_path", { from: "Coverage/Nested/a.md", to: "Coverage/copy.md" });
    await rejects("copy_path", { from: "missing.md", to: "Coverage/nope.md" }, "not_found");
    await rejects("copy_path", { from: "Coverage/Nested/a.md", to: "Coverage/copy.md" }, "already_exists");

    const flat = await invoke<Array<{ path: string; is_dir: boolean }>>("list_dir", {
      dir: "Coverage",
      recursive: false,
    });
    expect(flat.map((entry) => entry.path)).toEqual(["Coverage/Nested", "Coverage/copy.md"]);
    expect(await invoke<Array<{ path: string }>>("list_dir", { dir: "Coverage", recursive: true })).toHaveLength(3);
    const text = await invoke<{ content: string; kind: string; hash: string }>("read_file", {
      path: "Coverage/Nested/a.md",
    });
    expect(text).toMatchObject({ content: "Alpha #one", kind: "markdown" });
    await rejects("read_file", { path: "Coverage/missing.md" }, "not_found");

    const bytes = new TextEncoder().encode("hello");
    await invoke("import_file", { path: "Coverage/data.txt", bytes });
    await invoke("import_file", { path: "Coverage/data.txt", bytes });
    await invoke("import_file", { path: "Coverage/pixel.png", bytes: new Uint8Array([1, 2, 3]) });
    expect(await invoke<string>("read_raw", { path: "Coverage/data 1.txt" })).toBe("hello");
    expect(await invoke<string>("read_raw", { path: "Coverage/pixel.png" })).toContain("data:image/png;base64");
    expect(await invoke<{ content: null }>("read_file", { path: "Coverage/pixel.png" })).toMatchObject({
      content: null,
    });
    await rejects("read_raw", { path: "Coverage/no.raw" }, "not_found");
    await rejects("unknown_command", {}, "invalid");

    await invoke("delete_path", { path: "Coverage/Nested" });
    await rejects("delete_path", { path: "Coverage/Nested" }, "not_found");
  });

  it("handles optimistic writes, renames, links, search metadata and history", async () => {
    const created = await invoke<{ hash: string }>("write_file", {
      path: "Coverage target.md",
      content: "# Coverage target\n",
      expectedHash: null,
      root: "/mock/coverage",
    });
    await invoke("write_file", {
      path: "Coverage source.md",
      content: "Coverage target is plain here.\n[[Coverage target]] and ![[Coverage target]].\n",
      expectedHash: null,
      root: "/mock/coverage",
    });
    await rejects(
      "write_file",
      { path: "Coverage target.md", content: "stale", expectedHash: "bad", root: "/mock/coverage" },
      "conflict",
    );
    await invoke("write_file", {
      path: "Coverage target.md",
      content: "# Updated\n",
      expectedHash: created.hash,
      root: "/mock/coverage",
    });

    expect(await invoke<Array<unknown>>("search", { query: "", limit: 10 })).toEqual([]);
    expect(await invoke<Array<{ path: string }>>("search", { query: "updated", limit: 1 })).toHaveLength(1);
    expect(await invoke<Array<{ path: string }>>("backlinks", { path: "Coverage target.md" })).toHaveLength(2);
    expect(await invoke<Array<unknown>>("unlinked_mentions", { path: "Coverage target.md" })).toHaveLength(0);

    await invoke("create_file", {
      path: "Coverage mention.md",
      content: "A Coverage target mention without a link.",
      root: "/mock/coverage",
    });
    const mentions = await invoke<Array<{ line: number; text: string }>>("unlinked_mentions", {
      path: "Coverage target.md",
    });
    expect(mentions).toHaveLength(1);
    await invoke("link_mention", {
      source: "Coverage mention.md",
      line: mentions[0].line,
      text: mentions[0].text,
      target: "Coverage target.md",
    });
    expect(await invoke<string>("read_raw", { path: "Coverage mention.md" })).toContain("[[Coverage target]]");

    await invoke("create_file", {
      path: "Coverage alias.md",
      content: "A shorter label.",
      root: "/mock/coverage",
    });
    await invoke("link_mention", {
      source: "Coverage alias.md",
      line: 1,
      text: "shorter",
      target: "Coverage target.md",
    });
    expect(await invoke<string>("read_raw", { path: "Coverage alias.md" })).toContain("[[Coverage target|shorter]]");

    const renamed = await invoke<{ path: string; updated_links_in: string[] }>("rename_path", {
      from: "Coverage target.md",
      to: "Coverage renamed.md",
    });
    expect(renamed.path).toBe("Coverage renamed.md");
    await rejects("rename_path", { from: "missing.md", to: "new.md" }, "not_found");
    await rejects("rename_path", { from: "Coverage renamed.md", to: "Welcome.md" }, "already_exists");
    await invoke("make_dir", { path: "Coverage folder" });
    await rejects("rename_path", { from: "Coverage folder", to: "Coverage folder/inside" }, "invalid_path");

    const history = await invoke<Array<{ id: number; action: string }>>("file_history", {
      path: "Coverage renamed.md",
    });
    expect(history.some((item) => item.action === "renamed")).toBe(true);
    expect(await invoke<string>("version_content", { id: history[0].id })).toBeTypeOf("string");
    await invoke("restore_version", { path: "Coverage renamed.md", id: history[0].id, expectedHash: null });
    expect(await invoke<Array<unknown>>("tags")).toEqual(expect.any(Array));
    expect(await invoke<Array<unknown>>("aliases")).toEqual([]);
    expect(await invoke<string>("absolute_path", { path: "Coverage renamed.md" })).toContain("Coverage renamed.md");
    await rejects("print_window", {}, "invalid");
    await rejects("open_in_default_app", { path: "Coverage renamed.md" }, "invalid");
    await rejects("html_preview_document", { html: "<p>x</p>" }, "invalid");
    await rejects("outline", { path: "Coverage renamed.md" }, "invalid");
    await rejects("fix_links", { id: 999 }, "invalid");
    expect(await invoke<Array<unknown>>("unfinished_renames")).toEqual([]);
  });

  it("covers query operators, task mutations, daily formats and preferences", async () => {
    await invoke("create_file", {
      path: "Coverage tasks.md",
      content:
        "---\ntags: [coverage, nested/tag]\npriority: high\n---\n# Tasks\n- [ ] Open task 📅 2026-10-20\n  - [x] Child task\n- [>] Moved task\n- [-] Cancelled task\n",
      root: "/mock/coverage",
    });
    for (const query of [
      "tag:coverage show:priority sort:-title limit:2",
      "-tag:missing folder:Coverage",
      "priority=high",
      "priority!=low",
      "priority>good",
      "priority<z",
      "priority~ig",
      "task:all sort:path",
      "task:open Open",
    ]) {
      expect((await invoke<{ rows: unknown[] }>("query_notes", { query })).rows).toEqual(expect.any(Array));
    }

    await rejects("set_task", { path: "missing.md", line: 1, text: "x", done: true }, "not_found");
    await rejects("set_task", { path: "Coverage tasks.md", line: 1, text: "wrong", done: true }, "conflict");
    await invoke("set_task", { path: "Coverage tasks.md", line: 6, text: "Open task 📅 2026-10-20", done: true });
    await invoke("set_task", { path: "Coverage tasks.md", line: 6, text: "Open task 📅 2026-10-20", done: false });
    await rejects(
      "set_task_workflow",
      { path: "Coverage tasks.md", line: 6, text: "Open task 📅 2026-10-20", expectedState: "new", next: "wat" },
      "invalid",
    );
    await invoke("set_task_workflow", {
      path: "Coverage tasks.md",
      line: 6,
      text: "Open task 📅 2026-10-20",
      expectedState: "new",
      next: "in-progress",
    });
    await rejects(
      "set_task_workflow",
      { path: "Coverage tasks.md", line: 6, text: "Open task 📅 2026-10-20", expectedState: "new", next: "done" },
      "conflict",
    );

    expect(
      (
        await invoke<{ days: unknown[]; overdue: unknown[] }>("days", {
          from: "2026-10-19",
          to: "2026-10-21",
          today: "2026-10-28",
        })
      ).days,
    ).toHaveLength(3);
    expect(await invoke("carry_over", { day: "2026-10-20", path: null, newNote: true })).toMatchObject({
      to: "2026-10-20.md",
    });
    expect(await invoke("carry_over", { day: "2026-10-20", path: "Daily/today.md", newNote: false })).toMatchObject({
      to: "Daily/today.md",
    });

    await invoke("set_vault_preferences", {
      patch: { daily_format: "DD-MM-YYYY", folder_colors: { Coverage: "#fff" } },
      root: "/mock/coverage",
    });
    expect(await invoke<Record<string, unknown>>("vault_preferences")).toMatchObject({ daily_format: "DD-MM-YYYY" });
    await rejects("set_vault_preferences", { patch: {}, root: "/wrong" }, "invalid");
    await invoke("create_file", { path: "Coverage/28-10-2026.md", content: "# Daily", root: "/mock/coverage" });
    await rejects("days", { from: "2026-10-28", to: "2026-10-28", today: "2026-10-28" }, "invalid");
    await invoke("delete_path", { path: "Coverage/28-10-2026.md" });
    await invoke("set_vault_preferences", {
      patch: { daily_format: "YYYYMMDD" },
      root: "/mock/coverage",
    });
    await invoke("create_file", { path: "Coverage/20261029.md", content: "# Daily", root: "/mock/coverage" });
    await invoke("days", { from: "2026-10-29", to: "2026-10-29", today: "2026-10-29" });
  });

  it("validates and renders template configurations", async () => {
    await rejects("set_template_config", { config: { version: 2, folder: "", rules: [] } }, "invalid");
    await rejects(
      "set_template_config",
      {
        config: {
          version: 1,
          folder: "Templates",
          rules: [
            { folder: "A", template: null },
            { folder: "a", template: null },
          ],
        },
      },
      "invalid",
    );
    await rejects(
      "set_template_config",
      { config: { version: 1, folder: "Templates", rules: [{ folder: "A", template: "Outside.txt" }] } },
      "invalid",
    );
    await invoke("create_file", {
      path: "Templates/Coverage.md",
      content: "# {{title}}\n{{date}} {{time}} {{weekday}}",
      root: "/mock/coverage",
    });
    await invoke("set_template_config", {
      config: {
        version: 1,
        folder: "Templates",
        rules: [{ folder: "Projects", template: "Templates/Coverage.md" }],
      },
    });
    expect((await invoke<{ templates: unknown[] }>("list_templates", { path: null })).templates.length).toBeGreaterThan(
      0,
    );
    expect(await invoke("list_templates", { path: "Projects/Test.md" })).toMatchObject({
      default: { template: "Templates/Coverage.md", rule_folder: "Projects" },
    });
    await rejects(
      "render_template",
      { request: { path: "bad.txt", blank: true, template: null, timestamp: null, expected_template_hash: null } },
      "invalid_path",
    );
    await rejects(
      "render_template",
      {
        request: {
          path: "Projects/Bad.md",
          blank: true,
          template: "Templates/Coverage.md",
          timestamp: null,
          expected_template_hash: null,
        },
      },
      "invalid",
    );
    await rejects(
      "render_template",
      {
        request: {
          path: "Projects/Bad.md",
          blank: false,
          template: "Outside.md",
          timestamp: null,
          expected_template_hash: null,
        },
      },
      "invalid",
    );
    const preview = await invoke<TemplatePreview>("render_template", {
      request: {
        path: "Projects/Coverage note.md",
        blank: false,
        template: null,
        timestamp: "2026-10-28T10:30:00.000Z",
        expected_template_hash: null,
      },
    });
    expect(preview.content).toContain("Coverage note");
    await rejects(
      "render_template",
      {
        request: {
          path: "Projects/Stale.md",
          blank: false,
          template: "Templates/Coverage.md",
          timestamp: null,
          expected_template_hash: "stale",
        },
      },
      "conflict",
    );
    await invoke("create_note", {
      request: {
        path: "Projects/Coverage note.md",
        blank: false,
        template: null,
        timestamp: "2026-10-28T10:30:00.000Z",
        expected_template_hash: preview.template_hash,
      },
    });
    await rejects(
      "create_note",
      {
        request: {
          path: "Projects/Coverage note.md",
          blank: true,
          template: null,
          timestamp: null,
          expected_template_hash: null,
        },
      },
      "already_exists",
    );
    expect(await invoke<Array<[string, string]>>("template_starters")).toHaveLength(5);
  });
});

describe("browser mock planner behavior", () => {
  const makeEpic = (title: string) =>
    invoke<PlannerEpic>("planner_create_epic", { input: { title, description: "", color: "#123456" } });
  const makeTask = (title: string, epic_id: string | null = null, parent_id: string | null = null) =>
    invoke<PlannerTask>("planner_create_task", {
      input: {
        epic_id,
        parent_id,
        title,
        description: "",
        status: "new",
        due_date: "2026-11-02",
        estimate_minutes: 45,
      },
    });
  const eventInput = (title: string, recurrence_rule: string | null = null) => ({
    title,
    description: "Description",
    location: "Room",
    meeting_url: null,
    participants: ["one@example.test"],
    epic_id: null,
    color: null,
    all_day: true,
    start_value: "2026-11-01",
    end_value: "2026-11-02",
    timezone: "UTC",
    recurrence_rule,
  });

  it("covers epic and task validation, hierarchy, lifecycle and filters", async () => {
    await rejects("planner_create_epic", { input: { title: " ", description: "", color: "#000" } }, "invalid");
    const epic = await makeEpic(" Coverage epic ");
    await rejects("planner_update_epic", { id: "missing", input: { expected_revision: 1 } }, "not_found");
    await rejects(
      "planner_update_epic",
      { id: epic.id, input: { expected_revision: epic.revision, title: " " } },
      "invalid",
    );
    const updatedEpic = await invoke<PlannerEpic>("planner_update_epic", {
      id: epic.id,
      input: {
        expected_revision: epic.revision,
        title: "Updated epic",
        description: "Full",
        color: "#abcdef",
        position: 42,
      },
    });
    await rejects("planner_trash_epic", { id: updatedEpic.id, expectedRevision: updatedEpic.revision }, "invalid");

    await rejects(
      "planner_create_task",
      {
        input: {
          epic_id: null,
          parent_id: null,
          title: " ",
          description: "",
          status: "new",
          due_date: null,
          estimate_minutes: null,
        },
      },
      "invalid",
    );
    await rejects(
      "planner_create_task",
      {
        input: {
          epic_id: "missing",
          parent_id: null,
          title: "x",
          description: "",
          status: "new",
          due_date: null,
          estimate_minutes: null,
        },
      },
      "not_found",
    );
    const parent = await makeTask("Parent", epic.id);
    await rejects(
      "planner_create_task",
      {
        input: {
          epic_id: epic.id,
          parent_id: "missing",
          title: "x",
          description: "",
          status: "new",
          due_date: null,
          estimate_minutes: null,
        },
      },
      "not_found",
    );
    await rejects(
      "planner_create_task",
      {
        input: {
          epic_id: null,
          parent_id: parent.id,
          title: "x",
          description: "",
          status: "new",
          due_date: null,
          estimate_minutes: null,
        },
      },
      "invalid",
    );
    const child = await makeTask("Child", epic.id, parent.id);
    const grandchild = await makeTask("Grandchild", epic.id, child.id);
    await rejects(
      "planner_move_task",
      {
        id: parent.id,
        input: {
          expected_revision: parent.revision,
          epic_id: epic.id,
          parent_id: grandchild.id,
          status: "new",
          position: 1,
        },
      },
      "invalid",
    );
    await rejects(
      "planner_move_task",
      {
        id: parent.id,
        input: { expected_revision: parent.revision, epic_id: epic.id, parent_id: null, status: "done", position: 1 },
      },
      "invalid",
    );
    await rejects(
      "planner_complete_task",
      { id: parent.id, expectedRevision: parent.revision, allowIncompleteSubtasks: false, futureSessions: "keep" },
      "invalid",
    );

    const edited = await invoke<PlannerTask>("planner_update_task", {
      id: child.id,
      input: {
        expected_revision: child.revision,
        title: "Edited child",
        description: "detail",
        due_date: "2026-12-01",
        clear_due_date: false,
        estimate_minutes: 90,
        clear_estimate: false,
      },
    });
    const cleared = await invoke<PlannerTask>("planner_update_task", {
      id: child.id,
      input: { expected_revision: edited.revision, clear_due_date: true, clear_estimate: true },
    });
    expect(cleared).toMatchObject({ due_date: null, estimate_minutes: null });
    const done = await invoke<PlannerTask>("planner_complete_task", {
      id: parent.id,
      expectedRevision: parent.revision,
      allowIncompleteSubtasks: true,
      futureSessions: "keep",
    });
    const reopened = await invoke<PlannerTask>("planner_reopen_task", {
      id: parent.id,
      expectedRevision: done.revision,
    });
    expect(reopened.status).toBe("new");
    await rejects("planner_trash_task", { id: parent.id, expectedRevision: reopened.revision }, "invalid");
    const archived = await invoke<PlannerTask>("planner_archive_task", {
      id: parent.id,
      expectedRevision: reopened.revision,
    });
    const trashed = await invoke<PlannerTask>("planner_trash_task", {
      id: parent.id,
      expectedRevision: archived.revision,
    });
    const restored = await invoke<PlannerTask>("planner_restore_task", {
      id: parent.id,
      expectedRevision: trashed.revision,
    });
    expect(restored.trashed_at).toBeNull();

    const archivedEpic = await invoke<PlannerEpic>("planner_archive_epic", {
      id: updatedEpic.id,
      expectedRevision: updatedEpic.revision,
    });
    const trashedEpic = await invoke<PlannerEpic>("planner_trash_epic", {
      id: updatedEpic.id,
      expectedRevision: archivedEpic.revision,
    });
    await invoke("planner_restore_epic", { id: updatedEpic.id, expectedRevision: trashedEpic.revision });
    expect(await invoke<Array<PlannerTask>>("planner_tasks", { includeArchived: true, includeTrashed: true })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: parent.id })]),
    );
    expect(
      await invoke<Array<PlannerEpic>>("planner_epics", { includeArchived: false, includeTrashed: false }),
    ).toEqual(expect.any(Array));
    expect(await invoke("planner_summary")).toMatchObject({ is_empty: false });
    expect(
      await invoke<Array<unknown>>("planner_activity", { entityKind: "task", entityId: parent.id }),
    ).not.toHaveLength(0);
  });

  it("validates work sessions and covers scheduled, cancelled and all-day workload", async () => {
    const task = await makeTask("Session task");
    await rejects(
      "planner_create_work_session",
      {
        input: {
          task_id: "missing",
          all_day: false,
          start_value: "2026-11-01T10:00:00Z",
          end_value: "2026-11-01T11:00:00Z",
          timezone: "UTC",
        },
      },
      "not_found",
    );
    await rejects(
      "planner_create_work_session",
      {
        input: {
          task_id: task.id,
          all_day: false,
          start_value: "2026-11-01T11:00:00Z",
          end_value: "2026-11-01T10:00:00Z",
          timezone: "UTC",
        },
      },
      "invalid",
    );
    await rejects(
      "planner_create_work_session",
      {
        input: { task_id: task.id, all_day: true, start_value: "2026-11-02", end_value: "2026-11-01", timezone: "UTC" },
      },
      "invalid",
    );
    const session = await invoke<PlannerWorkSession>("planner_create_work_session", {
      input: {
        task_id: task.id,
        all_day: false,
        start_value: "2026-11-01T10:00:00.000Z",
        end_value: "2026-11-01T11:30:00.000Z",
        timezone: "UTC",
      },
    });
    await invoke("planner_create_work_session", {
      input: { task_id: task.id, all_day: true, start_value: "2026-11-02", end_value: "2026-11-03", timezone: "UTC" },
    });
    await rejects(
      "planner_update_work_session",
      {
        id: session.id,
        input: {
          expected_revision: 99,
          all_day: false,
          start_value: session.start_value,
          end_value: session.end_value,
          timezone: "UTC",
        },
      },
      "conflict",
    );
    const moved = await invoke<PlannerWorkSession>("planner_update_work_session", {
      id: session.id,
      input: {
        expected_revision: session.revision,
        all_day: false,
        start_value: "2026-11-01T12:00:00.000Z",
        end_value: "2026-11-01T13:00:00.000Z",
        timezone: "UTC",
      },
    });
    const cancelled = await invoke<PlannerWorkSession>("planner_cancel_work_session", {
      id: session.id,
      expectedRevision: moved.revision,
    });
    await rejects(
      "planner_update_work_session",
      {
        id: session.id,
        input: {
          expected_revision: cancelled.revision,
          all_day: false,
          start_value: session.start_value,
          end_value: session.end_value,
          timezone: "UTC",
        },
      },
      "invalid",
    );
    expect(
      await invoke<Array<PlannerWorkSession>>("planner_work_sessions", { taskId: task.id, includeCancelled: false }),
    ).toHaveLength(1);
    expect(
      await invoke<Array<PlannerWorkSession>>("planner_work_sessions", { taskId: null, includeCancelled: true }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: session.id, state: "cancelled" })]));
    const range = await invoke<{ workload: Array<{ minutes: number }> }>("planner_calendar_range", {
      from: "2026-11-01",
      to: "2026-11-03",
    });
    expect(range.workload.some((day) => day.minutes > 0)).toBe(true);
  });

  it("expands recurring events, exceptions, lifecycle, imports and exports", async () => {
    await rejects("planner_create_event", { input: eventInput(" ") }, "invalid");
    const daily = await invoke<PlannerEvent>("planner_create_event", {
      input: eventInput("Daily", "FREQ=DAILY;INTERVAL=2;UNTIL=20261107"),
    });
    await invoke("planner_create_event", { input: eventInput("Weekly", "FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261120") });
    await invoke("planner_create_event", { input: eventInput("Monthly", "FREQ=MONTHLY;INTERVAL=1;UNTIL=20270110") });
    await invoke("planner_create_event", { input: eventInput("Unknown", "FREQ=YEARLY;UNTIL=20261103") });
    expect(
      (await invoke<{ events: unknown[] }>("planner_calendar_range", { from: "2026-11-01", to: "2026-11-10" })).events
        .length,
    ).toBeGreaterThan(1);
    const replacement = await invoke<PlannerEvent>("planner_replace_event_occurrence", {
      seriesId: daily.id,
      expectedRevision: daily.revision,
      occurrenceKey: "2026-11-03",
      input: { ...eventInput("Replacement"), start_value: "2026-11-03", end_value: "2026-11-04" },
    });
    const afterReplace = (
      await invoke<Array<PlannerEvent>>("planner_events", {
        includeArchived: true,
        includeTrashed: true,
      })
    ).find((event) => event.id === daily.id)!;
    await invoke("planner_cancel_event_occurrence", {
      seriesId: daily.id,
      expectedRevision: afterReplace.revision,
      occurrenceKey: "2026-11-05",
    });
    expect(replacement.series_id).toBe(daily.id);

    const current = (
      await invoke<Array<PlannerEvent>>("planner_events", { includeArchived: true, includeTrashed: true })
    ).find((event) => event.id === daily.id)!;
    await rejects(
      "planner_update_event",
      { id: daily.id, input: { ...eventInput(" "), expected_revision: current.revision } },
      "invalid",
    );
    const updated = await invoke<PlannerEvent>("planner_update_event", {
      id: daily.id,
      input: { ...eventInput("Updated daily"), expected_revision: current.revision },
    });
    await rejects("planner_trash_event", { id: daily.id, expectedRevision: updated.revision }, "invalid");
    const archived = await invoke<PlannerEvent>("planner_archive_event", {
      id: daily.id,
      expectedRevision: updated.revision,
    });
    const trashed = await invoke<PlannerEvent>("planner_trash_event", {
      id: daily.id,
      expectedRevision: archived.revision,
    });
    await invoke("planner_restore_event", { id: daily.id, expectedRevision: trashed.revision });

    for (const [content, code] of [
      ["no calendar", "invalid"],
      ["BEGIN:VCALENDAR\nEND:VCALENDAR", "invalid"],
      ["BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nEND:VEVENT\nEND:VCALENDAR", "invalid"],
    ])
      await rejects("planner_ical_preview", { sourceKind: "coverage", content, fallbackTimezone: "UTC" }, code);
    const ical =
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:timed\r\nDTSTART:20261101T100000Z\r\nSUMMARY:Timed\r\nDESCRIPTION:Description\r\nLOCATION:Room\r\nURL:https://example.test\r\nRRULE:FREQ=DAILY;COUNT=2\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    const preview = await invoke<IcalImportPreview>("planner_ical_preview", {
      sourceKind: "coverage",
      content: ical,
      fallbackTimezone: "UTC",
    });
    await rejects("planner_ical_import", { preview, selectedKeys: ["unknown"], allowDuplicates: false }, "invalid");
    await invoke("planner_ical_import", { preview, selectedKeys: [preview.candidates[0].key], allowDuplicates: false });
    const duplicate = await invoke<IcalImportPreview>("planner_ical_preview", {
      sourceKind: "coverage",
      content: ical,
      fallbackTimezone: "UTC",
    });
    expect(duplicate.duplicates).toBe(1);
    await invoke("planner_ical_import", {
      preview: duplicate,
      selectedKeys: [duplicate.candidates[0].key],
      allowDuplicates: false,
    });
    await invoke("planner_ical_import", {
      preview: duplicate,
      selectedKeys: [duplicate.candidates[0].key],
      allowDuplicates: true,
    });
    expect(await invoke<string>("planner_ical_export")).toContain("BEGIN:VCALENDAR");
    expect(await invoke<string>("planner_ical_export_file", { path: "/tmp/out.ics" })).toBe("/tmp/out.ics");
    expect(await invoke<string>("planner_export", { format: "json" })).toContain("format_version");
    expect(await invoke<string>("planner_export", { format: "csv" })).toContain("entity_type");
    await rejects("planner_export", { format: "xml" }, "invalid");
    expect(await invoke<string>("planner_export_file", { format: "json", path: "/tmp/out.json" })).toBe(
      "/tmp/out.json",
    );
    expect(await invoke<string>("planner_restore_backup", { path: "/tmp/backup" })).toContain("planner.sqlite3");
  });

  it("imports markdown hierarchy and validates migration selections", async () => {
    await invoke("create_file", {
      path: "Coverage migration.md",
      content: "- [ ] Epic ^epic\n  - [ ] Task 📅 2026-11-03 ^task\n    - [x] Subtask\n- [>] Archived\n",
      root: "/mock/coverage",
    });
    const preview = await invoke<MarkdownImportPreview>("planner_migration_preview");
    await rejects(
      "planner_import_markdown",
      { preview, selectedFingerprints: ["unknown"], allowDuplicates: false, timezone: "UTC" },
      "invalid",
    );
    const selected = preview.groups
      .find((group) => group.source_path === "Coverage migration.md")!
      .tasks.map((task) => task.fingerprint);
    const first = await invoke<{ imported_epic_ids: string[]; imported_task_ids: string[] }>(
      "planner_import_markdown",
      {
        preview,
        selectedFingerprints: selected,
        allowDuplicates: false,
        timezone: "UTC",
      },
    );
    expect(first.imported_epic_ids).not.toHaveLength(0);
    expect(first.imported_task_ids).not.toHaveLength(0);
    await invoke("planner_import_markdown", {
      preview,
      selectedFingerprints: selected,
      allowDuplicates: false,
      timezone: "UTC",
    });
    await invoke("planner_import_markdown", {
      preview,
      selectedFingerprints: selected,
      allowDuplicates: true,
      timezone: "UTC",
    });
  });
});

describe("browser mock integrations", () => {
  it("manages subscriptions, agents, automation settings and streamed chat", async () => {
    await rejects(
      "add_calendar_subscription",
      { name: "", url: "ftp://invalid", color: "#000", refreshMinutes: 30 },
      "invalid",
    );
    const added = await invoke<{ id: string }>("add_calendar_subscription", {
      name: " Coverage ",
      url: "webcal://example.test/calendar.ics",
      color: "#123456",
      refreshMinutes: 15,
    });
    await rejects(
      "update_calendar_subscription",
      { id: "missing", name: "x", color: "#000", visible: true, refreshMinutes: 10 },
      "not_found",
    );
    await invoke("update_calendar_subscription", {
      id: added.id,
      name: "Updated",
      color: "#abcdef",
      visible: false,
      refreshMinutes: 60,
    });
    expect(await invoke("refresh_calendar_subscriptions", { force: true })).toEqual(expect.any(Array));
    expect(
      await invoke("calendar_overlay_range", { from: "2026-11-01", to: "2026-11-02", timezone: "UTC" }),
    ).toMatchObject({
      subscriptions: expect.any(Array),
    });
    await invoke("remove_calendar_subscription", { id: added.id });
    await rejects("remove_calendar_subscription", { id: added.id }, "not_found");

    const agents = await invoke<Array<{ name: string }>>("agents");
    expect(agents.length).toBeGreaterThan(0);
    expect(await invoke("mirror_agents")).toEqual({ written: [], removed: [], skipped: [] });
    await rejects("tessera_run", { name: "missing" }, "not_found");
    await rejects("tessera_test_event", { name: "missing", path: "x.md" }, "not_found");
    await invoke("tessera_run", { name: agents[0].name });
    await invoke("tessera_test_event", { name: agents[0].name, path: "Welcome.md" });
    await invoke("tessera_pause_all", { paused: true });
    await invoke("tessera_pause_agent", { name: agents[0].name, paused: true });
    await invoke("tessera_pause_agent", { name: agents[0].name, paused: false });
    await invoke("tessera_set_max_chain_depth", { depth: 7 });
    expect(await invoke("tessera_status")).toMatchObject({ paused: true, max_chain_depth: 7 });

    vi.useFakeTimers();
    expect(await invoke("chat_check")).toMatchObject({ version: "mock" });
    const run = await invoke<number>("chat_send", {
      message: "hello",
      session: null,
      context: [],
      active: null,
      agent: agents[0].name,
      selectionPath: "Welcome.md",
      selectionText: "selected",
      model: "mock-model",
    });
    await invoke("chat_send", {
      message: "plain",
      session: "mock-session",
      context: ["Welcome.md"],
      active: "Welcome.md",
      agent: null,
      selectionPath: null,
      selectionText: null,
      model: null,
    });
    vi.runAllTimers();
    await invoke("chat_stop", { run });
  });

  it("covers proposal decisions, rules, bookmarks, vault creation and updater states", async () => {
    const createdId = mockPropose("Coverage proposal.md", "created", "tester");
    const editedId = mockPropose("Welcome.md", "edited", "tester");
    const deletedId = mockPropose("Ideas.md", null, "tester");
    expect(await invoke("proposal_content", { id: createdId })).toBe("created");
    expect(await invoke("proposal_content", { id: 99999 })).toBeNull();
    expect(await invoke("proposal_base", { id: createdId })).toBeNull();
    expect(await invoke<Array<unknown>>("proposals", { includeDecided: false })).toHaveLength(3);
    await invoke("write_file", { path: "Welcome.md", content: "changed", expectedHash: null, root: "/mock/coverage" });
    await rejects("accept_proposal", { id: editedId, force: false, content: null }, "conflict");
    await invoke("accept_proposal", { id: editedId, force: true, content: "override" });
    await invoke("accept_proposal", { id: createdId, force: false, content: "custom" });
    await invoke("accept_proposal", { id: deletedId, force: false, content: null });
    await rejects("accept_proposal", { id: createdId, force: true, content: null }, "invalid");
    await rejects("reject_proposal", { id: 999999, reason: null }, "not_found");
    const rejectedId = mockPropose("Rejected.md", "no", "tester");
    await invoke("reject_proposal", { id: rejectedId, reason: undefined });
    expect(await invoke<Array<unknown>>("proposals", { includeDecided: true })).toHaveLength(4);

    await invoke("set_agent_rules", { rules: [{ path: "Projects", access: "write" }] });
    expect(await invoke("get_agent_rules")).toEqual([{ path: "Projects", access: "write" }]);
    await invoke("set_bookmarks", { paths: ["Welcome.md", "Projects"] });
    expect(await invoke("get_bookmarks")).toEqual(["Welcome.md", "Projects"]);
    expect(await invoke("create_vault", { parent: "/tmp", name: "Coverage" })).toEqual({
      root: "/tmp/Coverage",
      name: "Coverage",
    });
    expect(await invoke("cli_info")).toMatchObject({ installed: false });
    expect(await invoke("install_cli")).toMatchObject({ installed: true });
    expect(await invoke("update_status")).toMatchObject({ running: false });

    vi.useFakeTimers();
    const check = invoke("check_updates");
    await vi.advanceTimersByTimeAsync(600);
    expect(await check).toMatchObject({ update_available: true });
    await invoke("start_update");
    await rejects("start_update", {}, "invalid");
    expect(await invoke("update_status")).toMatchObject({ running: true });
    await invoke("cancel_update");
    await invoke("cancel_update");
  });
});
