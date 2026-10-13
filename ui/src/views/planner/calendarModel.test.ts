import { describe,expect,it } from "vitest";
import { timedLayout,visibleDays } from "./calendarModel";
import type { CalendarWorkSession,EventOccurrence } from "../../ipc/types";

const event=(id:string,start:string,end:string):EventOccurrence=>({event_id:id,series_id:id,occurrence_key:start.slice(0,10),title:id,description:"",location:"",meeting_url:null,participants:[],epic_id:null,color:null,all_day:false,start_value:start,end_value:end,timezone:"UTC",recurring:false});
describe("planner calendar presentation",()=>{
  it("uses a stable 42-day month and seven-day week",()=>{expect(visibleDays(new Date(2026,9,13),"month")).toHaveLength(42);expect(visibleDays(new Date(2026,9,13),"week")).toHaveLength(7);expect(visibleDays(new Date(2026,9,13),"day")).toHaveLength(1);});
  it("places overlaps side by side and later items back in the first column",()=>{const items=timedLayout([event("a","2026-10-13T09:00:00Z","2026-10-13T11:00:00Z"),event("b","2026-10-13T10:00:00Z","2026-10-13T10:30:00Z"),event("c","2026-10-13T11:00:00Z","2026-10-13T12:00:00Z")],[] as CalendarWorkSession[],"2026-10-13");expect(items.map(item=>item.column)).toEqual([0,1,0]);expect(items.slice(0,2).every(item=>item.columns===2)).toBe(true);});
});
