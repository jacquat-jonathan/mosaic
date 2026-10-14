import { useEffect,useState,type CSSProperties,type DragEvent,type MouseEvent } from "react";
import type { CalendarOverlayOccurrence,CalendarWorkSession,EventOccurrence,PlannerCalendarRange,PlannerWorkSession } from "../../ipc/types";
import { CALENDAR_END_HOUR,CALENDAR_START_HOUR,isoDay,timedLayout,visibleCalendarHours } from "./calendarModel";
import { TASK_DRAG } from "./UnscheduledTray";

const SESSION_DRAG="application/x-mosaic-work-session";
const HOURS=visibleCalendarHours();
const hourLabel=(hour:number)=>new Date(2020,0,1,hour).toLocaleTimeString(undefined,{hour:"numeric"});

export function WeekView({days,data,overlays,today,show,onEvent,onOverlay,onEmptyRange,onTaskDrop,onSessionMove,onSessionResize,onSessionCancel}:{days:Date[];data:PlannerCalendarRange;overlays:CalendarOverlayOccurrence[];today:string;show:{events:boolean;sessions:boolean;due:boolean};onEvent(id:string,key:string):void;onOverlay(item:CalendarOverlayOccurrence):void;onEmptyRange(day:string,startHour:number,endHour:number):void;onTaskDrop(taskId:string,day:string,hour:number|null):void;onSessionMove(session:PlannerWorkSession,day:string,hour:number|null):void;onSessionResize(session:PlannerWorkSession,minutes:number):void;onSessionCancel(session:PlannerWorkSession):void}){
  const [selecting,setSelecting]=useState<{day:string;startHour:number;currentHour:number}|null>(null);
  useEffect(()=>{const cancel=()=>setSelecting(null);window.addEventListener("mouseup",cancel);window.addEventListener("blur",cancel);return()=>{window.removeEventListener("mouseup",cancel);window.removeEventListener("blur",cancel);};},[]);
  const drop=(event:DragEvent,day:string,hour:number|null)=>{
    event.preventDefault();
    const task=event.dataTransfer.getData(TASK_DRAG),sessionId=event.dataTransfer.getData(SESSION_DRAG);
    if(task)onTaskDrop(task,day,hour);
    else if(sessionId){const session=data.work_sessions.find(item=>item.session.id===sessionId)?.session;if(session)onSessionMove(session,day,hour);}
  };
  return <div className="planner-week-wrap">
    <div className="planner-week-head"><div/>{days.map(date=>{const day=isoDay(date);return <div className={day===today?"today":""} key={day}><strong>{date.toLocaleDateString(undefined,{weekday:"short"})}</strong><span>{date.getDate()}</span></div>;})}</div>
    <div className="planner-all-day"><div className="planner-time-label">All day</div>{days.map(date=>{
      const day=isoDay(date),events=show.events?data.events.filter(item=>item.all_day&&item.start_value<=day&&item.end_value>day):[],external=overlays.filter(item=>item.all_day&&item.start_value<=day&&item.end_value>day),sessions=show.sessions?data.work_sessions.filter(item=>item.session.all_day&&item.session.start_value<=day&&item.session.end_value>day):[],due=show.due?data.due_markers.filter(item=>item.date===day):[];
      return <div className="planner-all-day-cell" key={day} onDragOver={event=>event.preventDefault()} onDrop={event=>drop(event,day,null)}>{due.map(marker=><span className="planner-due" key={marker.task_id}>◆ {marker.title}</span>)}{events.map(event=><button className="planner-event-chip" style={{borderColor:event.color??"var(--accent)"}} key={`${event.series_id}:${event.occurrence_key}`} onClick={()=>onEvent(event.series_id,event.occurrence_key)}>{event.recurring?"↻ ":""}{event.title}</button>)}{external.map(item=><button className="planner-event-chip read-only" style={{borderColor:item.color??"var(--muted)"}} key={`${item.source_id}:${item.uid}:${item.occurrence_key}`} onClick={()=>onOverlay(item)}>🔒 {item.title}<small>{item.source_name}</small></button>)}{sessions.map(item=><SessionChip key={item.session.id} item={item} onCancel={onSessionCancel}/>)}</div>;
    })}</div>
    <div className="planner-time-scroll"><div className="planner-hours">{HOURS.map(hour=><div key={hour}>{hourLabel(hour)}</div>)}</div>{days.map(date=>{
      const day=isoDay(date),items=timedLayout(show.events?data.events:[],show.sessions?data.work_sessions:[],day,overlays).filter(item=>item.end>CALENDAR_START_HOUR&&item.start<CALENDAR_END_HOUR);
      return <div className="planner-time-day" key={day}>{HOURS.map(hour=><button className="planner-hour-cell" aria-label={`Create event ${day} ${hourLabel(hour)}`} key={hour}
        data-selecting={selecting?.day===day&&hour>=Math.min(selecting.startHour,selecting.currentHour)&&hour<=Math.max(selecting.startHour,selecting.currentHour)?"true":undefined}
        onMouseDown={event=>{if(event.button===0)setSelecting({day,startHour:hour,currentHour:hour});}}
        onMouseEnter={(event:MouseEvent<HTMLButtonElement>)=>{if(event.buttons===1&&selecting?.day===day)setSelecting(current=>current?{...current,currentHour:hour}:null);}}
        onMouseUp={event=>{event.stopPropagation();if(!selecting||selecting.day!==day)return;const start=Math.min(selecting.startHour,hour),end=Math.max(selecting.startHour,hour)+1;setSelecting(null);onEmptyRange(day,start,end);}}
        onDragOver={event=>event.preventDefault()} onDrop={event=>drop(event,day,hour)} />)}{items.map(item=><TimedItem key={item.id} item={item} onEvent={onEvent} onOverlay={onOverlay} onResize={onSessionResize} onCancel={onSessionCancel}/>)}</div>;
    })}</div>
  </div>;
}

function SessionChip({item,onCancel}:{item:CalendarWorkSession;onCancel(session:PlannerWorkSession):void}){
  return <span className={`planner-session-chip status-${item.task_status}`} draggable onDragStart={event=>{event.dataTransfer.setData(SESSION_DRAG,item.session.id);event.dataTransfer.effectAllowed="move";}} style={{borderColor:item.color??"var(--accent)"}}><span>◷ {item.task_title}</span><button aria-label={`Cancel ${item.task_title} session`} onClick={()=>onCancel(item.session)}>×</button></span>;
}

function TimedItem({item,onEvent,onOverlay,onResize,onCancel}:{item:ReturnType<typeof timedLayout>[number];onEvent(id:string,key:string):void;onOverlay(item:CalendarOverlayOccurrence):void;onResize(session:PlannerWorkSession,minutes:number):void;onCancel(session:PlannerWorkSession):void}){
  const visibleStart=Math.max(item.start,CALENDAR_START_HOUR),visibleEnd=Math.min(item.end,CALENDAR_END_HOUR),top=(visibleStart-CALENDAR_START_HOUR)*40,height=Math.max(22,(visibleEnd-visibleStart)*40),style={top,left:`calc(${item.column/item.columns*100}% + 2px)`,width:`calc(${100/item.columns}% - 4px)`,height,"--item-color":item.event?.color??item.overlay?.color??item.session?.color??"var(--accent)"} as CSSProperties;
  if(item.kind==="event"){
    const event=item.event as EventOccurrence;
    return <button className="planner-timed-item event" style={style} onClick={()=>onEvent(event.series_id,event.occurrence_key)}><strong>{event.title}</strong><span>{event.recurring?"↻ ":""}{hourLabel(Math.floor(item.start))}</span></button>;
  }
  if(item.kind==="overlay"){
    const overlay=item.overlay as CalendarOverlayOccurrence;
    return <button className="planner-timed-item overlay" style={style} onClick={()=>onOverlay(overlay)}><strong>🔒 {overlay.title}</strong><span>{overlay.source_name} · {hourLabel(Math.floor(item.start))}</span></button>;
  }
  const session=item.session as CalendarWorkSession;
  return <div className={`planner-timed-item session status-${session.task_status}`} draggable onDragStart={event=>{event.dataTransfer.setData(SESSION_DRAG,session.session.id);event.dataTransfer.effectAllowed="move";}} style={style}><strong>◷ {session.task_title}</strong><span>{Math.round((item.end-item.start)*60)} min · {session.task_status.replace("-"," ")}</span><div><button aria-label={`Shorten ${session.task_title}`} onClick={()=>onResize(session.session,-15)}>−</button><button aria-label={`Lengthen ${session.task_title}`} onClick={()=>onResize(session.session,15)}>+</button><button aria-label={`Cancel ${session.task_title} session`} onClick={()=>onCancel(session.session)}>×</button></div></div>;
}
