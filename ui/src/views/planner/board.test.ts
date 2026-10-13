import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../ipc/api";

afterEach(()=>vi.unstubAllGlobals());

test("planner mock covers create, edit, move, complete, archive, trash, restore and history",async()=>{
  vi.stubGlobal("window",{dispatchEvent:vi.fn()});
  const epic=await api.createPlannerEpic({title:"Launch",description:"",color:"#5b8def"});
  const task=await api.createPlannerTask({epic_id:epic.id,parent_id:null,title:"Ship",description:"First",status:"new",due_date:null,estimate_minutes:60});
  const edited=await api.updatePlannerTask(task.id,{expected_revision:task.revision,title:"Ship Mosaic",description:"Ready",due_date:"2026-10-20",clear_due_date:false,estimate_minutes:90,clear_estimate:false});
  expect(edited).toMatchObject({title:"Ship Mosaic",due_date:"2026-10-20",estimate_minutes:90});
  await expect(api.updatePlannerTask(task.id,{expected_revision:task.revision,title:"Stale",clear_due_date:false,clear_estimate:false})).rejects.toMatchObject({code:"conflict"});
  const moved=await api.movePlannerTask(task.id,{expected_revision:edited.revision,epic_id:epic.id,parent_id:null,status:"in-progress",position:2048});
  const done=await api.completePlannerTask(task.id,moved.revision,false,"cancel");
  expect(done.status).toBe("done");
  const archived=await api.archivePlannerTask(task.id,done.revision);
  expect(archived.archived_at).not.toBeNull();
  const trashed=await api.trashPlannerTask(task.id,archived.revision);
  expect(trashed.trashed_at).not.toBeNull();
  const restored=await api.restorePlannerTask(task.id,trashed.revision);
  expect(restored.archived_at).toBeNull();
  expect(restored.trashed_at).toBeNull();
  expect((await api.plannerActivity("task",task.id)).map(entry=>entry.action)).toEqual(["created","updated","moved","completed","archived","trashed","restored"]);
});

test("planner migration preview imports selected tasks only once",async()=>{
  vi.stubGlobal("window",{dispatchEvent:vi.fn()});
  const preview=await api.plannerMigrationPreview();
  const candidate=preview.groups.flatMap(group=>group.tasks).find(task=>task.default_selected&&!task.duplicate);
  expect(candidate).toBeTruthy();
  const imported=await api.importMarkdownToPlanner(preview,[candidate!.fingerprint],false,"Europe/Zurich");
  expect(imported.imported_task_ids).toHaveLength(1);
  const repeated=await api.importMarkdownToPlanner(preview,[candidate!.fingerprint],false,"Europe/Zurich");
  expect(repeated.imported_task_ids).toHaveLength(0);
  expect(repeated.skipped_duplicates).toEqual([candidate!.fingerprint]);
});

