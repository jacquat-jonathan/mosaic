import { useVault } from "../state/vault";
import { parseView } from "./specialTabs";
import { CalendarView } from "./CalendarView";
import { ChatPanel } from "./ChatPanel";
import { ChatHistoryPage } from "./ChatHistory";
import { Workflows, WorkflowForm, RunDetail } from "./Workflows";
import { ActivityPanel } from "./ActivityPanel";
import { ConnectAiSection } from "./ConnectAi";
import { Settings } from "./Settings";
import { SearchPanel } from "./SearchPanel";
import { TaskBoard } from "./TaskBoard";
import { TaskQueryView } from "./TaskQueryView";

export function SpecialView({ path }: { path: string }) {
  const { kind, id } = parseView(path);
  const root = useVault((s) => s.vault?.root);
  switch (kind) {
    case "calendar":
      return <CalendarView />;
    case "week":
      return <CalendarView initialMode="week" />;
    case "today":
      return <CalendarView initialMode="day" />;
    case "chat":
      return <ChatPanel id={id} />;
    case "chats":
      return <ChatHistoryPage />;
    case "agents":
      return <Workflows agentsOnly />;
    case "workflows":
      return <Workflows />;
    case "workflow":
      return <Workflows name={id} />;
    case "new-workflow":
      return <WorkflowForm />;
    case "runs":
      return <Workflows runsOnly />;
    case "run":
      return <RunDetail id={id} />;
    case "activity":
      return <ActivityPanel />;
    case "connections":
      return <ConnectAiSection />;
    case "settings":
      return <Settings />;
    case "search":
      return <SearchPanel />;
    case "board":
      return <TaskBoard />;
    case "tasks":
    case "overdue":
    case "projects":
    case "planning":
    case "query":
      return <TaskQueryView key={`${root}/${kind}/${id}`} kind={kind} id={id} />;
    default:
      return <div className="empty">This workspace view is no longer available.</div>;
  }
}
