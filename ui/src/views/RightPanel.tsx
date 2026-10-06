import { useEffect, useMemo, useState } from "react";
import { isSpecialTab, contextKind, parseView } from "./specialTabs";
import { api } from "../ipc/api";
import { errorMessage, type Backlink, type Mention } from "../ipc/types";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { parse as parseMarkdownHeadings } from "./outline";
import { useUi } from "../state/ui";
import { useChat } from "../state/chat";
import { usePlanning } from "../state/planning";
import { RunDetail, WorkflowContext } from "./Workflows";
import { revealNotePosition } from "../editor/noteViews";
import { PropertiesEditor } from "../editor/PropertiesEditor";
import { FRONTMATTER_RE } from "../editor/livePreview";
import { dayStamp } from "../daily";
import { openDailyNote } from "../actions";
import { type Days } from "../ipc/types";
import { TaskList } from "./CalendarView";

/** Context follows the focused workspace, independently of the selected destination. */
export function RightPanel() {
  const active = useWorkspace(s => s.panes.find(p=>p.id === s.focused)?.active ?? null);
  const kind = contextKind(active);
  if (!active || !kind) return null;
  const id = parseView(active).id;
  return <aside className="right-panel" aria-label="Workspace context" data-focus-region tabIndex={-1}>
    <header className="context-head"><strong>{kind === "note" ? "Note details" : `${kind[0].toUpperCase()}${kind.slice(1)} details`}</strong><button aria-label="Close context panel" onClick={()=>useUi.getState().toggleRightPanel()}>×</button></header>
    {kind === "note" ? <LinksPanel key={active} /> : kind === "chat" ? <ChatContext id={id} /> : kind === "workflow" ? <WorkflowContext name={id} /> : kind === "run" ? <RunDetail id={id} compact /> : <CalendarContext />}
  </aside>;
}
function ChatContext({ id }: { id: string }) {
  const chat = useChat(s => s.chats[id]);
  if (!chat) return <p className="panel-meta">Chat unavailable.</p>;
  const last = [...chat.items].reverse().find(i => i.kind === "user");
  return <div className="context-content"><h3>Attachments</h3>{chat.attached.length ? chat.attached.map(p=><button key={p} onClick={()=>void useWorkspace.getState().open(p,{newTab:true})}>{p}</button>) : <p>No attached files.</p>}
    {(chat.selection || last?.selection) && <><h3>Selection</h3><blockquote>{(chat.selection || last?.selection)?.text}</blockquote></>}
    <dl><dt>Provider</dt><dd>Claude Code</dd><dt>Model</dt><dd>{chat.model || "Default"}</dd><dt>Session</dt><dd>{chat.session || "Not started"}</dd><dt>Cost</dt><dd>${chat.cost.toFixed(2)}</dd><dt>Status</dt><dd>{chat.run !== null ? "Running" : chat.noMosaic ? "Tools disconnected" : "Ready"}</dd></dl>
    {last && <><h3>Last message context</h3>{last.context.map(p=><p key={p}>{p}</p>)}</>}
  </div>;
}
function CalendarContext() {
  const day = usePlanning(s=>s.selectedDay);
  const revision = useVault(s=>s.revision);
  const [data,setData] = useState<Days | null>(null);
  const [error,setError] = useState<string | null>(null);
  const [tick,setTick] = useState(0);
  useEffect(()=>{let live=true;setData(null);setError(null);void api.days(day,day,dayStamp()).then(d=>live&&setData(d),e=>live&&setError(errorMessage(e)));return()=>{live=false;};},[day,revision,tick]);
  return <div className="context-content"><h3>{day}</h3><button onClick={()=>void openDailyNote(new Date(`${day}T12:00`),{newTab:true})}>Open daily note</button>{error&&<p className="error-text">{error}</p>}
    {data && <><p>{data.days[0]?.tasks.filter(t=>t.status === "open").length ?? 0} open tasks</p><h3>Overdue</h3><TaskList tasks={data.overdue} showNote onTick={(t,done)=>void api.setTask(t.path,t.line,t.text,done).then(()=>setTick(n=>n+1),e=>setError(errorMessage(e)))} /></>}
  </div>;
}

/** Backlinks and outline of the active note. */
function LinksPanel() {
  const active = useWorkspace((s) => s.panes.find((p) => p.id === s.focused)?.active ?? null);
  const content = useWorkspace((s) => (active ? s.buffers[active]?.content : null));
  const revision = useVault((s) => s.revision);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);

  useEffect(() => {
    if (!active || isSpecialTab(active)) {
      setBacklinks([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api.backlinks(active).then((b) => live && setBacklinks(b), () => live && setBacklinks([]));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [active, revision]);

  const headings = useMemo(() => (active?.endsWith(".md") && content ? parseMarkdownHeadings(content) : []), [active, content]);
  const grouped = useMemo(() => {
    const m = new Map<string, Backlink[]>();
    for (const b of backlinks) {
      const list = m.get(b.source) ?? [];
      // Canvases and drawings have no lines (all 0): tell their links apart by context.
      if (!list.some((x) => x.line === b.line && x.context === b.context)) list.push(b);
      m.set(b.source, list);
    }
    return [...m];
  }, [backlinks]);

  if (!active) return <div className="links-panel"><div className="panel-meta">No file open.</div></div>;
  if (isSpecialTab(active)) return <div className="links-panel"><div className="panel-meta">Backlinks and the outline show for notes.</div></div>;
  return (
    <div className="links-panel">
      {active.endsWith(".md") && content !== null && content !== undefined && <section><h3>Properties</h3><PropertiesEditor key={content.match(FRONTMATTER_RE)?.[1] ?? ""} yaml={content.match(FRONTMATTER_RE)?.[1] ?? ""} onChange={yaml=>{
        const fm=FRONTMATTER_RE.exec(content); const next=`---\n${yaml.trimEnd()}\n---`;
        useWorkspace.getState().replaceContent(active, fm ? next + content.slice(fm[0].length) : next + "\n\n" + content);
      }} onEditSource={()=>revealNotePosition(active, 1)} /></section>}
      <section>
        <h3>Backlinks <span className="count">{backlinks.length}</span></h3>
        {grouped.length === 0 && <p className="panel-meta">No other notes link here yet.</p>}
        {grouped.map(([source, links]) => (
          <div key={source} className="backlink">
            <button className="backlink-source" onClick={(e) => void useWorkspace.getState().open(source, { newTab: e.metaKey })}>
              {source.replace(/\.md$/, "")}
            </button>
            {links.map((l, i) =>
              l.context ? (
                <div key={i} className="backlink-context" title={l.line ? `Line ${l.line}` : undefined}>
                  {l.context}
                </div>
              ) : null,
            )}
          </div>
        ))}
      </section>
      {active.endsWith(".md") && <UnlinkedMentions path={active} revision={revision} />}
      {headings.length > 0 && (
        <section>
          <h3>Outline</h3>
          <div className="outline">
            {headings.map((h, i) => (
              <button key={i} className="outline-item" style={{ paddingLeft: (h.level - 1) * 12 }} onClick={()=>revealNotePosition(active, content?.split("\n").slice(0, h.line-1).reduce((n,line)=>n+line.length+1,0) ?? 0)}>
                {h.text}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** Notes that mention this one by name (or alias) without linking; one click makes the link. */
function UnlinkedMentions({ path, revision }: { path: string; revision: number }) {
  const [open, setOpen] = useState(false);
  const [mentions, setMentions] = useState<Mention[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api.unlinkedMentions(path).then(
      (m) => live && setMentions(m),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [open, path, revision]);
  const link = async (m: Mention) => {
    setError(null);
    try {
      await api.linkMention(m.source, m.line, m.text, path);
      setMentions((list) => list?.filter((x) => !(x.source === m.source && x.line === m.line)) ?? null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <section>
      <h3>
        <button className="section-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "▾" : "▸"} Unlinked mentions {mentions && open ? <span className="count">{mentions.length}</span> : null}
        </button>
      </h3>
      {open && mentions?.length === 0 && <p className="panel-meta">No other notes mention this one without a link.</p>}
      {open &&
        mentions?.map((m) => (
          <div key={`${m.source}:${m.line}`} className="backlink mention">
            <button className="backlink-source" onClick={(e) => void useWorkspace.getState().open(m.source, { newTab: e.metaKey })}>
              {m.source.replace(/\.md$/, "")}
            </button>
            <div className="backlink-context">{m.context}</div>
            <button className="mention-link" title={`Turn “${m.text}” into a link to this note`} onClick={() => void link(m)}>
              Link
            </button>
          </div>
        ))}
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
