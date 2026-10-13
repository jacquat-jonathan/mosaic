import { useState } from "react";
import { api } from "../../ipc/api";
import { errorMessage, type PlannerEpic } from "../../ipc/types";

export function EpicEditor({epic,defaultColor,onClose,onDone}:{epic:PlannerEpic|null;defaultColor:string;onClose():void;onDone():void}){
  const [title,setTitle]=useState(epic?.title??""),[color,setColor]=useState(epic?.color??defaultColor),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const save=async()=>{if(!title.trim())return;setBusy(true);setError(null);try{if(epic)await api.updatePlannerEpic(epic.id,{expected_revision:epic.revision,title:title.trim(),color});else await api.createPlannerEpic({title:title.trim(),description:"",color});onDone();}catch(reason){setError(errorMessage(reason));}finally{setBusy(false);}};
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal epic-editor" role="dialog" aria-modal="true" aria-labelledby="epic-editor-title" onMouseDown={event=>event.stopPropagation()}>
    <header><h2 id="epic-editor-title">{epic?"Edit epic":"New epic"}</h2><button aria-label="Close epic editor" onClick={onClose}>×</button></header>
    <form onSubmit={event=>{event.preventDefault();void save();}}>
      <label>Title<input autoFocus value={title} onChange={event=>setTitle(event.target.value)} placeholder="Epic title"/></label>
      <label>Color<input type="color" value={color} onChange={event=>setColor(event.target.value)}/></label>
      {error&&<p className="error-text">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy||!title.trim()}>{busy?"Saving…":"Save epic"}</button></footer>
    </form>
  </section></div>;
}
