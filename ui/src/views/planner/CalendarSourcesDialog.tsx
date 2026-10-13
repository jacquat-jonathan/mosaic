import { useState } from "react";
import { RefreshCw,Trash2 } from "lucide-react";
import { api } from "../../ipc/api";
import { errorMessage,type CalendarSubscription } from "../../ipc/types";

export function CalendarSourcesDialog({subscriptions,onChange,onClose}:{subscriptions:CalendarSubscription[];onChange():Promise<void>;onClose():void}){
  const [name,setName]=useState(""),[url,setUrl]=useState(""),[color,setColor]=useState("#6477d4"),[interval,setIntervalValue]=useState(30),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const run=async(action:()=>Promise<unknown>)=>{setBusy(true);setError(null);try{await action();await onChange();}catch(reason){setError(errorMessage(reason));}finally{setBusy(false);}};
  const add=()=>run(async()=>{await api.addCalendarSubscription(name,url,color,interval);setName("");setUrl("");});
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal calendar-sources" role="dialog" aria-modal="true" aria-labelledby="calendar-sources-title" onMouseDown={event=>event.stopPropagation()}>
    <header><div><h2 id="calendar-sources-title">Calendar subscriptions</h2><p>Read-only HTTPS or webcal feeds. Addresses are kept in your macOS Keychain.</p></div><button aria-label="Close calendar subscriptions" onClick={onClose}>×</button></header>
    <div className="calendar-source-list">{subscriptions.length===0?<p className="panel-meta">No external calendars yet.</p>:subscriptions.map(item=><article key={item.id} style={{"--source-color":item.color} as React.CSSProperties}>
      <label><input type="checkbox" checked={item.visible} disabled={busy} onChange={event=>void run(()=>api.updateCalendarSubscription(item.id,item.name,item.color,event.target.checked,item.refresh_minutes))}/><strong>{item.name}</strong></label>
      <span>{item.has_cache?(item.last_success?`Updated ${new Date(item.last_success).toLocaleString()}`:"Cached"):"Not cached yet"}</span>
      {item.last_error&&<small className="warning-text">⚠ {item.last_error}</small>}
      <button className="icon" aria-label={`Remove ${item.name}`} disabled={busy} onClick={()=>void run(()=>api.removeCalendarSubscription(item.id))}><Trash2 size={14}/></button>
    </article>)}</div>
    <form onSubmit={event=>{event.preventDefault();void add();}}><h3>Add subscription</h3><label>Name<input value={name} required onChange={event=>setName(event.target.value)} placeholder="Team calendar"/></label><label>Subscription URL<input value={url} required type="url" onChange={event=>setUrl(event.target.value)} placeholder="https://… or webcal://…"/></label><div><label>Color<input type="color" value={color} onChange={event=>setColor(event.target.value)}/></label><label>Refresh<select value={interval} onChange={event=>setIntervalValue(Number(event.target.value))}><option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>Hourly</option></select></label></div>
      {error&&<p className="error-text">{error}</p>}<footer><button type="button" disabled={busy} onClick={()=>void run(()=>api.refreshCalendarSubscriptions(true))}><RefreshCw size={14}/> Refresh all</button><button className="primary" disabled={busy||!name.trim()||!url.trim()}>{busy?"Working…":"Add calendar"}</button></footer>
    </form>
  </section></div>;
}
