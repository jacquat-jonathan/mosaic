import { useEffect, useRef } from "react";
import { Bot, CalendarClock, Inbox, ListChecks, MessagesSquare, Plug, Workflow } from "lucide-react";
import { useUi, type Destination } from "../state/ui";
import { ChatList } from "./ChatHistory";
export { ChatList } from "./ChatHistory";
import { useWorkspace } from "../state/workspace";
import { useAttention } from "../state/attention";
import { useReview } from "../state/review";
import { SearchPanel } from "./SearchPanel";
import { TagsPanel } from "./TagsPanel";
import { BookmarksPanel } from "./BookmarksPanel";
import { viewPath, parseView } from "./specialTabs";

export function AreaSidebar({ destination }: { destination: Destination }) {
  const tab = useUi((s) => s.sidebarTab);
  const open = useUi.getState().openView;
  if (destination === "find")
    return (
      <>
        <div className="area-nav" aria-label="Find views">
          {(
            [
              ["search", "Search"],
              ["bookmarks", "Bookmarks"],
              ["tags", "Tags"],
            ] as const
          ).map(([id, title]) => (
            <button key={id} aria-pressed={tab === id} onClick={() => useUi.getState().setSidebarTab(id)}>
              {title}
            </button>
          ))}
          <button onClick={() => open("search")}>Open search in workspace</button>
        </div>
        {tab === "tags" ? <TagsPanel /> : tab === "bookmarks" ? <BookmarksPanel /> : <SearchPanel />}
      </>
    );
  if (destination === "plan")
    return (
      <nav className="area-nav" aria-label="Plan views">
        <button onClick={() => open("board")}>Board</button>
        <button onClick={() => open("calendar")}>Calendar</button>
        <p className="panel-meta">Markdown task queries remain available through Search and query blocks.</p>
      </nav>
    );
  return <AiSidebar />;
}
export function AiSidebar() {
  const newChat = useRef<HTMLButtonElement>(null);
  const open = useUi.getState().openView;
  const section = useUi((s) => s.aiSection);
  const active = useWorkspace((s) => s.panes.find((p) => p.id === s.focused)?.active);
  useEffect(() => {
    if (!active?.startsWith("mosaic:")) return;
    const kind = parseView(active).kind;
    if (["chat", "chats"].includes(kind)) useUi.getState().setAiSection("chats");
    else if (
      ["agents", "workflows", "workflow", "new-workflow", "runs", "run", "activity", "connections"].includes(kind)
    )
      useUi.getState().setAiSection("automations");
  }, [active]);
  const agents = useAttention((s) => s.agents);
  const pending = useReview((s) => s.pending.length);
  const disconnected = useAttention((s) => s.disconnected);
  const item = (kind: string, label: string, Icon: typeof Workflow, id?: string) => (
    <button
      key={kind + (id ?? "")}
      aria-current={
        active === viewPath(kind, id) || (kind === "runs" && active?.startsWith("mosaic:run/")) ? "page" : undefined
      }
      onClick={() => open(kind, id)}
    >
      <Icon size={15} /> <span>{label}</span>
    </button>
  );
  return (
    <nav className="area-nav ai-nav" aria-label="AI views">
      <div className="ai-section-switch" role="group" aria-label="AI sidebar section">
        {(["chats", "automations"] as const).map((value) => (
          <button key={value} aria-pressed={section === value} onClick={() => useUi.getState().setAiSection(value)}>
            {value === "chats" ? "Chats" : "Automations"}
          </button>
        ))}
      </div>
      <div className="ai-section-content">
        {section === "chats" ? (
          <>
            <button ref={newChat} className="primary ai-new-chat" onClick={() => useUi.getState().showChat()}>
              + New chat
            </button>
            {item("chats", "All chats", MessagesSquare)}
            <ChatList fallback={newChat} />
          </>
        ) : (
          <>
            {item("workflows", "Workflows", Workflow)}
            {!!agents.length && (
              <div className="ai-workflow-list" aria-label="Workflows">
                {agents.map((a) => item("workflow", a.title, CalendarClock, a.name))}
              </div>
            )}
            <div className="ai-automation-nav">
              {item("runs", "All runs", ListChecks)}
              {item("activity", `Activity & review${pending ? ` · ${pending}` : ""}`, Inbox)}
            </div>
          </>
        )}
      </div>
      <details className="ai-manage" open={disconnected || undefined}>
        <summary>Manage</summary>
        {item("agents", "Agent library", Bot)}
        {item("connections", `Connections${disconnected ? " · Disconnected" : ""}`, Plug)}
      </details>
    </nav>
  );
}
