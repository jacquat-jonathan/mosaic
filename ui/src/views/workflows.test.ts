import { expect, test } from "vitest";
import { workflowContent, pendingForRun, workflowDeleteTarget } from "./Workflows";
import type { Agent, AgentRun, Proposal } from "../ipc/types";

test("workflow editing preserves unrelated frontmatter and the source body", () => {
  const source="---\nname: weekly-review\ncustom: keep me\nmay_change: [Old]\nschedule: daily 08:00\n---\n\n# Instructions\nKeep this.\n";
  const edited=workflowContent(source,"fri 17:00",["Daily","Reviews"]);
  expect(edited).toContain("custom: keep me"); expect(edited).toContain("name: weekly-review"); expect(edited).toContain("schedule: fri 17:00"); expect(edited).not.toContain("may_change"); expect(edited).toContain("may-change:"); expect(edited).toContain("# Instructions\nKeep this.\n");
  const manual=workflowContent(edited,null,[]); expect(manual).not.toContain("schedule:"); expect(manual).toContain("may-change: []");
});
test("invalid YAML fails rather than silently replacing the agent", () => { expect(()=>workflowContent("---\nfield: [broken\n---\nBody",null,[])).toThrow(); });
test("review state is tied to exact run proposal IDs", () => {
  const run={proposal_ids:[2,3]} as AgentRun;
  const pending=[{id:1},{id:2},{id:4}] as Proposal[];
  expect(pendingForRun(run,pending).map(p=>p.id)).toEqual([2]);
  expect(pendingForRun({} as AgentRun,pending)).toEqual([]);
});
test("deleting a workflow targets a note or the whole skill folder", () => {
  expect(workflowDeleteTarget({ path: "Agents/Weekly review.md", skill_folder: false } as Agent)).toBe("Agents/Weekly review.md");
  expect(workflowDeleteTarget({ path: "Agents/Inbox triage/SKILL.md", skill_folder: true } as Agent)).toBe("Agents/Inbox triage");
});
