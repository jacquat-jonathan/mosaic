import { afterEach,describe,expect,it,vi } from "vitest";
import { api } from "../../ipc/api";

describe("planner calendar browser API",()=>{
  it("creates and independently moves sessions and expands recurring events",async()=>{
    vi.stubGlobal("window",{dispatchEvent:vi.fn()});
    const task=await api.createPlannerTask({epic_id:null,parent_id:null,title:"Calendar work",description:"",status:"new",due_date:"2026-10-14",estimate_minutes:90});
    const first=await api.createPlannerWorkSession({task_id:task.id,all_day:false,start_value:"2026-10-13T08:00:00.000Z",end_value:"2026-10-13T09:00:00.000Z",timezone:"UTC"});
    const second=await api.createPlannerWorkSession({task_id:task.id,all_day:false,start_value:"2026-10-13T08:30:00.000Z",end_value:"2026-10-13T09:30:00.000Z",timezone:"UTC"});
    await api.updatePlannerWorkSession(first.id,{expected_revision:first.revision,all_day:false,start_value:"2026-10-13T10:00:00.000Z",end_value:"2026-10-13T11:00:00.000Z",timezone:"UTC"});
    expect((await api.plannerWorkSessions(task.id)).find(item=>item.id===second.id)?.start_value).toBe("2026-10-13T08:30:00.000Z");
    await api.createPlannerEvent({title:"Focus",description:"",location:"",meeting_url:null,participants:[],epic_id:null,color:"#5b8def",all_day:false,start_value:"2026-10-13T12:00:00.000Z",end_value:"2026-10-13T13:00:00.000Z",timezone:"UTC",recurrence_rule:"FREQ=DAILY;UNTIL=20261015"});
    const range=await api.plannerCalendarRange("2026-10-13","2026-10-15");
    expect(range.events.filter(item=>item.title==="Focus")).toHaveLength(3);
    expect(range.work_sessions.filter(item=>item.session.task_id===task.id)).toHaveLength(2);
    expect(range.due_markers.some(item=>item.task_id===task.id)).toBe(true);
    expect(range.unscheduled_tasks.some(item=>item.id===task.id)).toBe(false);
  });
});
afterEach(()=>vi.unstubAllGlobals());
