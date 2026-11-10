// @vitest-environment jsdom
import { expect, test } from "vitest";
import events from "../../../fixtures/events.json";
import { mockInvoke, mockPropose, resetMock } from "./mock";
import type { IndexProgress } from "./types";

test("mock emits the same vault, history and planner envelopes as Tauri", async () => {
  resetMock();
  const received: Record<string, unknown> = {};
  const names = ["vault-changed", "history-changed", "planner-changed"] as const;
  const listeners = names.map((name) => {
    const listener = (event: Event) => {
      received[name] = (event as CustomEvent).detail;
    };
    window.addEventListener(`mock-${name}`, listener);
    return () => window.removeEventListener(`mock-${name}`, listener);
  });
  try {
    await mockInvoke("create_file", { path: "Note.md", content: "old", root: null });
    const id = mockPropose("Note.md", "new");
    await mockInvoke("accept_proposal", { id, force: false, content: null });
    await mockInvoke("planner_create_task", {
      input: {
        title: "Task",
        description: "",
        status: "new",
        epic_id: null,
        parent_id: null,
        due_date: null,
        estimate_minutes: null,
      },
    });
    for (const name of names) expect(received[name]).toEqual(events[name]);
    // Index progress is produced by the host, not simulated by the in-memory backend.
    const progress: IndexProgress = events["index-progress"];
    expect(progress.finished).toBe(false);
  } finally {
    for (const remove of listeners) remove();
  }
});
