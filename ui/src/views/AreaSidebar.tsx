import { useEffect } from "react";
import { Bot, CalendarClock, Inbox, ListChecks, MessagesSquare, Plug, Workflow } from "lucide-react";
import { useUi, type Destination } from "../state/ui";
import { useChat, chatGroup } from "../state/chat";
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
  const chats = useChat((s) => s.chats);
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
            <button className="primary ai-new-chat" onClick={() => useUi.getState().showChat()}>
              + New chat
            </button>
            {item("chats", "All chats", MessagesSquare)}
            <ChatList />
            {!Object.keys(chats).length && <p className="panel-meta">Your saved conversations appear here.</p>}
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
export function ChatList() {
  const active = useWorkspace((s) => s.panes.find((p) => p.id === s.focused)?.active);
  const chats = useChat((s) => s.chats);
  return (
    <>
      {["Today", "Previous 7 days", "Older"].map((group) => {
        const list = Object.values(chats)
          .filter((c) => chatGroup(c.updated) === group)
          .sort((a, b) => b.updated - a.updated);
        return list.length ? (
          <details key={group} open={group !== "Older"}>
            <summary>{group}</summary>
            {list.map((c) => (
              <div className="chat-nav-row" key={c.id}>
                <button
                  aria-current={active === viewPath("chat", c.id) ? "page" : undefined}
                  onClick={() => useUi.getState().openView("chat", c.id)}
                >
                  {c.title}
                  {c.run !== null
                    ? " · Running"
                    : c.items.at(-1)?.kind === "error"
                      ? " · Failed"
                      : c.noMosaic
                        ? " · Tools disconnected"
                        : ""}
                </button>
                <button
                  aria-label={`Actions for ${c.title}`}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    useUi.getState().showMenu(r.left, r.bottom, [
                      {
                        label: "Rename",
                        action: async () => {
                          const title = await useUi.getState().askText({ title: "Rename chat", value: c.title });
                          if (title?.trim()) useChat.getState().update(c.id, { title: title.trim() });
                        },
                      },
                      {
                        label: "Delete chat",
                        danger: true,
                        action: async () => {
                          if (
                            !(await useUi
                              .getState()
                              .ask({ title: "Delete chat?", body: c.title, confirmLabel: "Delete", danger: true }))
                          )
                            return;
                          useChat.getState().remove(c.id);
                          const ws = useWorkspace.getState();
                          for (const pane of ws.panes)
                            if (pane.tabs.includes(viewPath("chat", c.id)))
                              ws.closeTab(pane.id, viewPath("chat", c.id));
                        },
                      },
                    ]);
                  }}
                >
                  ⋯
                </button>
              </div>
            ))}
          </details>
        ) : null;
      })}
    </>
  );
}
