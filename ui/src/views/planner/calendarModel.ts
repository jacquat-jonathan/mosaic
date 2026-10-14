import type { CalendarOverlayOccurrence, CalendarWorkSession, EventOccurrence } from "../../ipc/types";

export type CalendarMode="month"|"week"|"day";
export const DAY_MS=86_400_000;
export const CALENDAR_START_HOUR=5;
export const CALENDAR_END_HOUR=23;
export const CALENDAR_MINUTES_PER_STEP=15;
export const EXPANDED_CALENDAR_MIN_WIDTH=840;
export const EVENT_DRAG="application/x-mosaic-calendar-event";
export const SESSION_DRAG="application/x-mosaic-work-session";
export const isCompactCalendarWidth=(width:number)=>width<EXPANDED_CALENDAR_MIN_WIDTH;
export const visibleCalendarHours=()=>Array.from({length:CALENDAR_END_HOUR-CALENDAR_START_HOUR},(_,index)=>CALENDAR_START_HOUR+index);
export const isoDay=(date:Date)=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
export const atNoon=(date:Date)=>new Date(date.getFullYear(),date.getMonth(),date.getDate(),12);
export const addDays=(date:Date,days:number)=>{const next=atNoon(date);next.setDate(next.getDate()+days);return next;};
export const startOfWeek=(date:Date,sunday=false)=>addDays(date,-((date.getDay()+(sunday?0:6))%7));
export function visibleDays(anchor:Date,mode:CalendarMode,sunday=false):Date[]{
  if(mode==="day")return[atNoon(anchor)];
  void sunday;
  const start=startOfWeek(mode==="week"?anchor:new Date(anchor.getFullYear(),anchor.getMonth(),1));
  const count=mode==="week"?5:30;return Array.from({length:count},(_,index)=>addDays(start,Math.floor(index/5)*7+index%5));
}
export const localDate=(value:string,timezone:string)=>new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(value));
export const localHour=(value:string,timezone:string)=>{const parts=new Intl.DateTimeFormat("en",{timeZone:timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(value));return Number(parts.find(part=>part.type==="hour")?.value??0)+Number(parts.find(part=>part.type==="minute")?.value??0)/60;};
export type TimedCalendarItem={id:string;start:number;end:number;kind:"event"|"session"|"overlay";event?:EventOccurrence;session?:CalendarWorkSession;overlay?:CalendarOverlayOccurrence;column:number;columns:number};
export function timedLayout(events:EventOccurrence[],sessions:CalendarWorkSession[],day:string,overlays:CalendarOverlayOccurrence[]=[]):TimedCalendarItem[]{
  const raw:Omit<TimedCalendarItem,"column"|"columns">[]=[...events.filter(item=>!item.all_day&&localDate(item.start_value,item.timezone)===day).map(event=>({id:`event:${event.series_id}:${event.occurrence_key}`,start:localHour(event.start_value,event.timezone),end:localHour(event.end_value,event.timezone),kind:"event" as const,event})),...sessions.filter(item=>!item.session.all_day&&localDate(item.session.start_value,item.session.timezone)===day).map(session=>({id:`session:${session.session.id}`,start:localHour(session.session.start_value,session.session.timezone),end:localHour(session.session.end_value,session.session.timezone),kind:"session" as const,session})),...overlays.filter(item=>!item.all_day&&localDate(item.start_value,item.timezone)===day).map(overlay=>({id:`overlay:${overlay.source_id}:${overlay.uid}:${overlay.occurrence_key}`,start:localHour(overlay.start_value,overlay.timezone),end:localHour(overlay.end_value,overlay.timezone),kind:"overlay" as const,overlay}))].sort((a,b)=>a.start-b.start||b.end-a.end);
  const result:TimedCalendarItem[]=[];let group:typeof raw=[];const flush=()=>{if(!group.length)return;const ends:number[]=[];const assigned=group.map(item=>{let column=ends.findIndex(end=>end<=item.start);if(column<0){column=ends.length;ends.push(item.end);}else ends[column]=item.end;return{...item,column};});const columns=Math.max(1,ends.length);result.push(...assigned.map(item=>({...item,columns})));group=[];};
  let groupEnd=-1;for(const item of raw){if(group.length&&item.start>=groupEnd)flush();group.push(item);groupEnd=Math.max(groupEnd,item.end);}flush();return result;
}
export const toLocalInput=(value:string)=>{const date=new Date(value),offset=date.getTimezoneOffset()*60000;return new Date(date.getTime()-offset).toISOString().slice(0,16);};
export const fromLocalInput=(value:string)=>new Date(value).toISOString();
export const formatCalendarDate=(value:string)=>{const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);return match?`${match[3]}/${match[2]}/${match[1]}`:value;};
export const parseCalendarDate=(value:string)=>{const match=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());if(!match)return null;const [,day,month,year]=match,iso=`${year}-${month}-${day}`,date=new Date(`${iso}T12:00:00`);return isoDay(date)===iso?iso:null;};
