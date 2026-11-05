import { Notice } from "../design-system/components";
import { DesignSystemScope } from "./DesignSystemScope";
import { useVault } from "../state/vault";
import { parseView } from "./specialTabs";
import { CalendarView } from "./CalendarView";
import { ChatPanel } from "./ChatPanel";
import { ChatHistoryPage } from "./ChatHistory";
import { Workflows, WorkflowForm, RunDetail } from "./Workflows";
import { ActivityPanel } from "./ActivityPanel";
import { useEffect } from "react";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { Settings } from "./Settings";
import { SearchPanel } from "./SearchPanel";
import { TaskBoard } from "./TaskBoard";
import { TaskQueryView } from "./TaskQueryView";

export function SpecialView({ path }: { path: string }) {
  const { kind, id } = parseView(path);
  const root = useVault((s) => s.vault?.root);
  switch (kind) {
    case "calendar":
      return <CalendarView key={`${root}/${kind}`} />;
    case "week":
      return <CalendarView key={`${root}/${kind}`} initialMode="week" />;
    case "today":
      return <CalendarView key={`${root}/${kind}`} initialMode="day" />;
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
      return <LegacyConnections />;
    case "settings":
      return <Settings />;
    case "search":
      return <SearchPanel />;
    case "board":
      return <TaskBoard key={root} />;
    case "tasks":
    case "overdue":
    case "projects":
    case "planning":
    case "query":
      return <TaskQueryView key={`${root}/${kind}/${id}`} kind={kind} id={id} />;
    default:
      return (
        <DesignSystemScope className="empty workspace-empty">
          <Notice>This workspace view is no longer available.</Notice>
        </DesignSystemScope>
      );
  }
}

function LegacyConnections() {
  useEffect(() => {
    const workspace = useWorkspace.getState();
    const pane = workspace.panes.find((item) => item.active === "mosaic:connections");
    if (pane) useWorkspace.setState({ focused: pane.id });
    useUi.getState().openSettings("ai");
    if (pane) workspace.closeTab(pane.id, "mosaic:connections");
  }, []);
  return null;
}
