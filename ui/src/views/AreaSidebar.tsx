import { useEffect, useRef } from "react";
import { Bot, CalendarClock, Inbox, ListChecks, MessagesSquare, Plug, Workflow } from "lucide-react";
import { useUi, type Destination } from "../state/ui";
import { ChatList } from "./ChatHistory";
import { useWorkspace } from "../state/workspace";
import { useAttention } from "../state/attention";
import { useReview } from "../state/review";
import { SearchPanel } from "./SearchPanel";
import { TagsPanel } from "./TagsPanel";
import { BookmarksPanel } from "./BookmarksPanel";
import { viewPath, parseView } from "./specialTabs";
import { Button, SegmentedControl } from "../design-system/components";
import { DesignSystemScope } from "./DesignSystemScope";
import "./sidebarNavigation.css";

export { ChatList } from "./ChatHistory";

export function AreaSidebar({ destination }: { destination: Destination }) {
  const tab = useUi((s) => s.sidebarTab);
  const open = useUi.getState().openView;
  const active = useWorkspace((state) => state.panes.find((pane) => pane.id === state.focused)?.active);
  if (destination === "find")
    return (
      <>
        <DesignSystemScope as="nav" className="area-nav find-navigation" aria-label="Find views">
          {(
            [
              ["search", "Search"],
              ["bookmarks", "Bookmarks"],
              ["tags", "Tags"],
            ] as const
          ).map(([id, title]) => (
            <Button
              className="area-link"
              key={id}
              aria-pressed={(tab === "tags" || tab === "bookmarks" ? tab : "search") === id}
              onClick={() => useUi.getState().setSidebarTab(id)}
            >
              {title}
            </Button>
          ))}
          <Button className="area-link" onClick={() => open("search")}>
            Open search in workspace
          </Button>
        </DesignSystemScope>
        {tab === "tags" ? <TagsPanel /> : tab === "bookmarks" ? <BookmarksPanel /> : <SearchPanel />}
      </>
    );
  if (destination === "plan")
    return (
      <DesignSystemScope as="nav" className="area-nav plan-navigation" aria-label="Plan views">
        <Button
          className="area-link"
          aria-current={active === viewPath("board") ? "page" : undefined}
          onClick={() => open("board")}
        >
          Board
        </Button>
        <Button
          className="area-link"
          aria-current={active && ["calendar", "week", "today"].includes(parseView(active).kind) ? "page" : undefined}
          onClick={() => open("calendar")}
        >
          Calendar
        </Button>
        <p className="mds-hint">Markdown task queries remain available through Search and query blocks.</p>
      </DesignSystemScope>
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
    <Button
      className="area-link"
      key={kind + (id ?? "")}
      aria-current={
        active === viewPath(kind, id) || (kind === "runs" && active?.startsWith("mosaic:run/")) ? "page" : undefined
      }
      onClick={() => open(kind, id)}
    >
      <Icon size={16} aria-hidden="true" /> <span>{label}</span>
    </Button>
  );
  return (
    <DesignSystemScope as="nav" className="area-nav ai-nav" aria-label="AI views">
      <SegmentedControl
        label="AI sidebar section"
        value={section}
        options={[
          { value: "chats", label: "Chats" },
          { value: "automations", label: "Automations" },
        ]}
        onChange={(value) => useUi.getState().setAiSection(value)}
      />
      <div className="ai-section-content">
        {section === "chats" ? (
          <>
            <Button
              variant="secondary"
              ref={newChat}
              className="area-link ai-new-chat"
              onClick={() => useUi.getState().showChat()}
            >
              + New chat
            </Button>
            {item("chats", "All chats", MessagesSquare)}
            <ChatList fallback={newChat} inheritScope />
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
    </DesignSystemScope>
  );
}
