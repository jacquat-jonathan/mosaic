import { useEffect, useState } from "react";
import { api } from "../../ipc/api";
import { errorMessage, isCoreError, type PlannerEpic, type PlannerTask, type PlannerTaskStatus } from "../../ipc/types";
import { useUi } from "../../state/ui";
import { PLANNER_STATUSES } from "./plannerModel";
import { ActivityTimeline } from "./ActivityTimeline";

export function TaskEditor({ task, epics, tasks, onChanged, onClose, onReload }: { task: PlannerTask; epics: PlannerEpic[]; tasks: PlannerTask[]; onChanged(task: PlannerTask | null): void; onClose(): void; onReload(): void }) {
  const [title,setTitle]=useState(task.title),[description,setDescription]=useState(task.description),[due,setDue]=useState(task.due_date??""),[estimate,setEstimate]=useState(task.estimate_minutes?.toString()??"");
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[conflict,setConflict]=useState(false);
  useEffect(()=>{setTitle(task.title);setDescription(task.description);setDue(task.due_date??"");setEstimate(task.estimate_minutes?.toString()??"");setError(null);setConflict(false);},[task.id,task.revision]);
  const run=async(action:()=>Promise<PlannerTask>)=>{setBusy(true);setError(null);setConflict(false);try{onChanged(await action());}catch(e){setError(errorMessage(e));setConflict(isCoreError(e)&&e.code==="conflict");}finally{setBusy(false);}};
  const save=()=>run(()=>api.updatePlannerTask(task.id,{expected_revision:task.revision,title,description,due_date:due||null,clear_due_date:!due,estimate_minutes:estimate?Number(estimate):null,clear_estimate:!estimate}));
  const futurePolicy=async()=>{const future=(await api.plannerWorkSessions(task.id,false)).filter(session=>!session.all_day&&session.start_value>new Date().toISOString()||session.all_day&&session.start_value>new Date().toISOString().slice(0,10));if(!future.length)return"cancel" as const;if(await useUi.getState().ask({title:"Cancel future work sessions?",body:`${future.length} future session${future.length===1?"":"s"} can be cancelled now.`,confirmLabel:"Cancel sessions"}))return"cancel" as const;if(await useUi.getState().ask({title:"Keep future work sessions?",body:"They will remain visible after this task is completed.",confirmLabel:"Keep sessions"}))return"keep" as const;return null;};
  const status=async(next:PlannerTaskStatus)=>{
    if(next===task.status)return;
    if(next==="done"){
      const open=tasks.some(item=>item.parent_id===task.id&&item.status!=="done"&&!item.archived_at);
      if(open&&!await useUi.getState().ask({title:"Complete task with unfinished subtasks?",body:"The subtasks will remain incomplete.",confirmLabel:"Complete task"}))return;
      const policy=await futurePolicy();if(!policy)return;return run(()=>api.completePlannerTask(task.id,task.revision,open,policy));
    }
    if(task.status==="done"){
      return run(async()=>{const reopened=await api.reopenPlannerTask(task.id,task.revision);return next==="new"?reopened:api.movePlannerTask(reopened.id,{expected_revision:reopened.revision,epic_id:reopened.epic_id,parent_id:reopened.parent_id,status:next,position:reopened.position});});
    }
    return run(()=>api.movePlannerTask(task.id,{expected_revision:task.revision,epic_id:task.epic_id,parent_id:task.parent_id,status:next,position:task.position}));
  };
  const moveEpic=async(epicId:string|null)=>{
    let parent=task.parent_id;
    if(parent&&epicId!==task.epic_id){if(!await useUi.getState().ask({title:"Promote this subtask?",body:"Moving it to another epic makes it a top-level task.",confirmLabel:"Promote and move"}))return;parent=null;}
    await run(()=>api.movePlannerTask(task.id,{expected_revision:task.revision,epic_id:epicId,parent_id:parent,status:task.status,position:task.position}));
  };
  const archive=async()=>{if(!await useUi.getState().ask({title:"Archive task?",body:task.title,confirmLabel:"Archive"}))return;await run(()=>api.archivePlannerTask(task.id,task.revision));onChanged(null);};
  const trash=async()=>{if(!await useUi.getState().ask({title:"Delete task?",body:"It will move to Deleted and remain recoverable.",confirmLabel:"Delete"}))return;await run(()=>api.trashPlannerTask(task.id,task.revision));onChanged(null);};
  const addSubtask=async()=>{const title=await useUi.getState().askText({title:"New subtask",value:"",placeholder:`Part of ${task.title}`});if(!title?.trim())return;await run(()=>api.createPlannerTask({epic_id:task.epic_id,parent_id:task.id,title:title.trim(),description:"",status:"new",due_date:null,estimate_minutes:null}));};
  const promote=async()=>{if(!task.parent_id||!await useUi.getState().ask({title:"Promote subtask?",body:"It will become a top-level task in the same epic.",confirmLabel:"Promote"}))return;await run(()=>api.movePlannerTask(task.id,{expected_revision:task.revision,epic_id:task.epic_id,parent_id:null,status:task.status,position:task.position+1024}));};
  const reorder=(direction:-1|1)=>run(()=>api.movePlannerTask(task.id,{expected_revision:task.revision,epic_id:task.epic_id,parent_id:task.parent_id,status:task.status,position:task.position+direction*1536}));
  const readOnly=!!task.archived_at||!!task.trashed_at;
  return <aside className="planner-editor" aria-label={`Edit ${task.title}`}>
    <header><h2>Task</h2><button aria-label="Close task editor" onClick={onClose}>×</button></header>
    {conflict&&<div className="conflict-bar"><span>This task changed elsewhere.</span><button onClick={onReload}>Reload</button></div>}
    {error&&<p className="error-text">{error}</p>}
    <label>Title<input value={title} disabled={readOnly} onChange={event=>setTitle(event.target.value)} /></label>
    <label>Description<textarea rows={5} value={description} disabled={readOnly} onChange={event=>setDescription(event.target.value)} /></label>
    <label>Status<select value={task.status} disabled={busy||readOnly} onChange={event=>void status(event.target.value as PlannerTaskStatus)}>{PLANNER_STATUSES.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    <label>Epic<select value={task.epic_id??""} disabled={busy||readOnly} onChange={event=>void moveEpic(event.target.value||null)}><option value="">Unassigned</option>{epics.filter(epic=>!epic.archived_at&&!epic.trashed_at).map(epic=><option value={epic.id} key={epic.id}>{epic.title}</option>)}</select></label>
    <div className="planner-editor-row"><label>Due date<input type="date" value={due} disabled={readOnly} onChange={event=>setDue(event.target.value)} /></label><label>Estimate (minutes)<input type="number" min="0" value={estimate} disabled={readOnly} onChange={event=>setEstimate(event.target.value)} /></label></div>
    {!readOnly&&<div className="planner-editor-tools"><button onClick={()=>void addSubtask()}>Add subtask</button>{task.parent_id&&<button onClick={()=>void promote()}>Promote</button>}<button aria-label="Move task earlier" onClick={()=>void reorder(-1)}>Move earlier</button><button aria-label="Move task later" onClick={()=>void reorder(1)}>Move later</button></div>}
    <p className="panel-meta">Revision {task.revision}{task.parent_id?" · Subtask":""}</p>
    <ActivityTimeline kind="task" id={task.id} revision={task.revision}/>
    <footer>{task.trashed_at?<button onClick={()=>void run(()=>api.restorePlannerTask(task.id,task.revision))}>Restore</button>:task.archived_at?<><button onClick={()=>void run(()=>api.restorePlannerTask(task.id,task.revision))}>Restore</button><button className="danger" onClick={()=>void trash()}>Delete</button></>:<button className="danger" onClick={()=>void archive()}>Archive</button>}<button className="primary" disabled={busy||!title.trim()||readOnly} onClick={()=>void save()}>{busy?"Saving…":"Save changes"}</button></footer>
  </aside>;
}

