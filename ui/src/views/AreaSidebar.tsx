import { useUi, type Destination } from "../state/ui";
import { useChat, chatGroup } from "../state/chat";
import { useWorkspace } from "../state/workspace";
import { useAttention } from "../state/attention";
import { useReview } from "../state/review";
import { SearchPanel } from "./SearchPanel";
import { TagsPanel } from "./TagsPanel";
import { BookmarksPanel } from "./BookmarksPanel";
import { viewPath } from "./specialTabs";
import { usePlanning } from "../state/planning";

export function AreaSidebar({ destination }: { destination: Destination }) {
  const tab = useUi(s => s.sidebarTab);
  const open = useUi.getState().openView;
  const saved = usePlanning(s => s.views);
  if (destination === "find") return <>
    <div className="area-nav" aria-label="Find views">
      {([['search', 'Search'], ['bookmarks', 'Bookmarks'], ['tags', 'Tags']] as const).map(([id, title]) => <button key={id} aria-pressed={tab === id} onClick={() => useUi.getState().setSidebarTab(id)}>{title}</button>)}
      <button onClick={() => open("search")}>Open search in workspace</button>
    </div>
    {tab === "tags" ? <TagsPanel /> : tab === "bookmarks" ? <BookmarksPanel /> : <SearchPanel />}
  </>;
  if (destination === "plan") return <nav className="area-nav" aria-label="Plan views">
    {[["today", "Today"], ["calendar", "Calendar"], ["tasks", "Tasks"], ["board", "Task board"]].map(([id, title]) => <button key={id} onClick={() => open(id)}>{title}</button>)}
    <h3>Saved views</h3>
    {[["week", "My week"], ["overdue", "Overdue"], ["projects", "Project tasks"]].map(([id, title]) => <button key={id} onClick={() => open(id)}>{title}</button>)}
    {saved.map(v => <button key={v.id} onClick={() => open("planning", v.id)}>{v.title}</button>)}
    <button onClick={() => void usePlanning.getState().create()}>+ New view</button>
  </nav>;
  return <AiSidebar />;
}
export function AiSidebar() {
  const open = useUi.getState().openView;
  const chats = useChat(s => s.chats);
  const pending = useReview(s => s.pending.length);
  const disconnected = useAttention(s => s.disconnected);
  return <nav className="area-nav ai-nav" aria-label="AI views">
    <button className="primary" onClick={() => useUi.getState().showChat()}>+ New chat</button>
    <button onClick={() => open("chats")}>Chats</button>
    <ChatList />
    <h3>Work</h3>
    {[["agents", "Agents"], ["workflows", "Workflows"], ["runs", "Runs"], ["activity", `Activity${pending ? ` · ${pending} need review` : ""}`], ["connections", `Connections${disconnected ? " · Disconnected" : ""}`]].map(([id, title]) => <button key={id} onClick={() => open(id)}>{title}</button>)}
    {Object.keys(chats).length === 0 && <p className="panel-meta">Chats save automatically in this vault's app storage.</p>}
  </nav>;
}
export function ChatList() {
  const chats = useChat(s => s.chats);
  return <>{["Today", "Previous 7 days", "Older"].map(group => {
    const list = Object.values(chats).filter(c => chatGroup(c.updated) === group).sort((a,b) => b.updated - a.updated);
    return list.length ? <section key={group}><h3>{group}</h3>{list.map(c => <div className="chat-nav-row" key={c.id}>
      <button onClick={() => useUi.getState().openView("chat", c.id)}>{c.title}{c.run !== null ? " · Running" : c.items.at(-1)?.kind === "error" ? " · Failed" : c.noMosaic ? " · Tools disconnected" : ""}</button>
      <button aria-label={`Actions for ${c.title}`} onClick={e => {
        const r = e.currentTarget.getBoundingClientRect();
        useUi.getState().showMenu(r.left, r.bottom, [
          { label: "Rename", action: async () => { const title = await useUi.getState().askText({ title: "Rename chat", value: c.title }); if (title?.trim()) useChat.getState().update(c.id, { title: title.trim() }); } },
          { label: "Delete chat", danger: true, action: async () => {
            if (!await useUi.getState().ask({ title: "Delete chat?", body: c.title, confirmLabel: "Delete", danger: true })) return;
            useChat.getState().remove(c.id);
            const ws = useWorkspace.getState(); for (const pane of ws.panes) if (pane.tabs.includes(viewPath("chat", c.id))) ws.closeTab(pane.id, viewPath("chat", c.id));
          } },
        ]);
      }}>⋯</button>
    </div>)}</section> : null;
  })}</>;
}
