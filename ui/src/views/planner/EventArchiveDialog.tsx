import { useEffect,useState } from "react";
import { api } from "../../ipc/api";
import { errorMessage,type PlannerEvent } from "../../ipc/types";

export function EventArchiveDialog({onChange,onClose}:{onChange():Promise<void>;onClose():void}){
  const [events,setEvents]=useState<PlannerEvent[]>([]),[view,setView]=useState<"archive"|"trash">("archive"),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const load=async()=>{try{setEvents(await api.plannerEvents(true,true));setError(null);}catch(reason){setError(errorMessage(reason));}};
  useEffect(()=>{void load();},[]);
  const run=async(action:()=>Promise<unknown>)=>{setBusy(true);setError(null);try{await action();await load();await onChange();}catch(reason){setError(errorMessage(reason));}finally{setBusy(false);}};
  const visible=events.filter(item=>view==="trash"?!!item.trashed_at:!!item.archived_at&&!item.trashed_at);
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal event-archive" role="dialog" aria-modal="true" aria-labelledby="event-archive-title" onMouseDown={event=>event.stopPropagation()}><header><h2 id="event-archive-title">Local event archive</h2><button aria-label="Close event archive" onClick={onClose}>×</button></header><div className="segmented"><button aria-pressed={view==="archive"} onClick={()=>setView("archive")}>Archive</button><button aria-pressed={view==="trash"} onClick={()=>setView("trash")}>Trash</button></div>{error&&<p className="error-text">{error}</p>}<div className="event-archive-list">{visible.length===0?<p className="panel-meta">No events here.</p>:visible.map(item=><article key={item.id}><div><strong>{item.title}</strong><span>{item.all_day?item.start_value:new Date(item.start_value).toLocaleString()}</span></div><button disabled={busy} onClick={()=>void run(()=>api.restorePlannerEvent(item.id,item.revision))}>{view==="trash"?"Restore from Trash":"Restore"}</button>{view==="archive"&&<button className="danger" disabled={busy} onClick={()=>void run(()=>api.trashPlannerEvent(item.id,item.revision))}>Move to Trash</button>}</article>)}</div></section></div>;
}
