import { useEffect, useState } from "react";
import { api } from "../ipc/api";
import { errorMessage, type QueryResult } from "../ipc/types";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { useUi } from "../state/ui";
import { usePlanning } from "../state/planning";
import { parseView } from "./specialTabs";
import { CalendarView } from "./CalendarView";
import { ChatPanel } from "./ChatPanel";
import { ChatList } from "./AreaSidebar";
import { Workflows, WorkflowForm, RunDetail } from "./Workflows";
import { ActivityPanel } from "./ActivityPanel";
import { ConnectAiSection } from "./ConnectAi";
import { Settings } from "./Settings";
import { SearchPanel } from "./SearchPanel";

export function SpecialView({ path }: { path: string }) {
  const { kind, id } = parseView(path);
  switch (kind) {
    case "calendar": return <CalendarView />;
    case "week": return <CalendarView initialMode="week" />;
    case "today": return <CalendarView initialMode="day" />;
    case "chat": return <ChatPanel id={id} />;
    case "chats": return <div className="workspace-page"><h1>Chats</h1><button className="primary" onClick={()=>useUi.getState().showChat()}>New chat</button><ChatList /></div>;
    case "agents": return <Workflows agentsOnly />;
    case "workflows": return <Workflows />;
    case "workflow": return <Workflows name={id} />;
    case "new-workflow": return <WorkflowForm />;
    case "runs": return <Workflows runsOnly />;
    case "run": return <RunDetail id={id} />;
    case "activity": return <div className="workspace-page"><h1>AI activity</h1><ActivityPanel /></div>;
    case "connections": return <div className="workspace-page"><h1>Connections</h1><ConnectAiSection /></div>;
    case "settings": return <Settings />;
    case "search": return <SearchPanel />;
    case "tasks": case "overdue": case "projects": case "planning": return <TaskView kind={kind} id={id} />;
    default: return <div className="empty">This workspace view is no longer available.</div>;
  }
}
function TaskView({ kind, id }: { kind: string; id: string }) {
  const saved = usePlanning(s => s.views.find(v => v.id === id));
  const revision = useVault(s => s.revision);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const query = kind === "planning" ? saved?.query : kind === "overdue" ? "task:open due<today sort:due limit:1000" : kind === "projects" ? "task:open tag:project sort:due limit:1000" : "task:open sort:due limit:1000";
  useEffect(() => { let live=true; setResult(null); if(query) void api.query(query).then(r=>{if(live){setResult(r);setError(null);}},e=>live&&setError(errorMessage(e))); return()=>{live=false;}; },[query,revision,tick]);
  return <div className="workspace-page"><h1>{saved?.title ?? (kind === "overdue" ? "Overdue" : kind === "projects" ? "Project tasks" : "Tasks")}</h1>
    {error && <p className="error-text">{error}</p>}{!query && <p>This saved view is unavailable.</p>}
    {result && <p className="panel-meta">{result.total} results{result.total > result.rows.length ? ` · showing ${result.rows.length}` : ""}</p>}
    {result?.rows.map((r,i)=><div className="task-row" key={`${r.path}:${r.task?.line ?? i}`}>
      {r.task && <input type="checkbox" aria-label={r.task.text} checked={r.task.status === "done"} disabled={!["open","done"].includes(r.task.status)} onChange={e=>void api.setTask(r.path,r.task!.line,r.task!.text,e.target.checked).then(()=>setTick(t=>t+1),e=>setError(errorMessage(e)))} />}
      <span>{r.task?.text ?? r.title}</span><button onClick={()=>void useWorkspace.getState().open(r.path,{newTab:true})}>{r.title}</button>
    </div>)}
    {result?.total === 0 && <p>No tasks match this view.</p>}
  </div>;
}
