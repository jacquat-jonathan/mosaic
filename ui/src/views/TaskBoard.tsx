import { useEffect, useState } from "react";
import { api, openExternal } from "../ipc/api";
import { errorMessage, type QueryResult } from "../ipc/types";
import { useVault } from "../state/vault";
import { resolveLink } from "../links";
import { useWorkspace } from "../state/workspace";
import { renderInlineMarkdown } from "../markdown";
import { taskGroups, taskKey, workflowState, WORKFLOW_STATES, type BoardTask, type WorkflowState } from "./taskBoardModel";

const DRAG_TYPE = "application/x-mosaic-task";
export function TaskBoard() {
  const root = useVault(s => s.vault?.root);
  const revision = useVault(s => s.revision);
  const buffers = useWorkspace(s => s.buffers);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dragged, setDragged] = useState<BoardTask | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState("");
  useEffect(() => {
    let live = true;
    void api.query("task:open|done limit:1000").then(r => { if (live) setResult(r); }, e => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [root, revision, refresh]);
  useEffect(() => { setResult(null); setSearch(""); setFolder(""); setError(null); setDragged(null); setDropTarget(null); }, [root]);
  const unavailable = (row: BoardTask) => busy || !!(buffers[row.path]?.dirty || buffers[row.path]?.conflict || buffers[row.path]?.deleted);
  const move = async (row: BoardTask, next: WorkflowState) => {
    if (root !== useVault.getState().vault?.root || unavailable(row) || next === workflowState(row.task)) return;
    setBusy(true); setError(null); setDragged(null); setDropTarget(null);
    try {
      await api.setTaskWorkflow(row.path, row.task.line, row.task.text, workflowState(row.task), next);
      if (root === useVault.getState().vault?.root) await useWorkspace.getState().externalChange(row.path);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); setRefresh(n => n + 1); }
  };
  const filtered = taskGroups(result?.rows ?? []).filter(g => (!folder || g.root.path.startsWith(folder)) && (!search.trim() || g.tasks.some(r => r.task.text.toLowerCase().includes(search.trim().toLowerCase()))));
  const parents = filtered.filter(g => g.tasks.length > 1).map(g => ({ ...g, standalone: false }));
  const singles = filtered.filter(g => g.tasks.length === 1);
  const groups = [...parents, ...(singles.length ? [{ root: singles[0].root, tasks: singles.flatMap(g => g.tasks), standalone: true }] : [])];
  const folders = [...new Set((result?.rows ?? []).map(r => r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/") + 1) : ""))].filter(Boolean).sort();
  const totals = WORKFLOW_STATES.map(s => groups.reduce((n, g) => n + g.tasks.filter(r => workflowState(r.task) === s.id).length, 0));
  const card = (row: BoardTask, parent: boolean) => <article key={taskKey(row)} className={`board-card ${parent ? "parent-task" : ""}`} draggable={!unavailable(row)}
    onDragStart={e => {
      if (unavailable(row) || (e.target as HTMLElement).closest("button, select, input, a")) { e.preventDefault(); return; }
      e.dataTransfer.setData(DRAG_TYPE, taskKey(row)); e.dataTransfer.effectAllowed = "move"; setDragged(row);
    }} onDragEnd={() => { setDragged(null); setDropTarget(null); }}>
    {parent && <span className="panel-meta">Parent task</span>}
    <div className="board-card-text" onClick={e => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("a, [data-target]");
      if (!target) return;
      e.preventDefault();
      if (target.tagName === "A") { void openExternal((target as HTMLAnchorElement).href); return; }
      const vault = useVault.getState();
      const path = resolveLink(target.dataset.target ?? "", vault.entries, row.path, vault.aliases);
      if (path) void useWorkspace.getState().open(path, { newTab: true });
    }} dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(row.task.text || "Untitled task") }} />
    {row.task.due && <span className="panel-meta">Due {row.task.due}</span>}
    <div className="board-card-actions"><button title={row.path} onClick={() => void useWorkspace.getState().open(row.path, { newTab: true })}>{row.title} · {row.task.line}</button>
      <select aria-label={`State of ${row.task.text}`} value={workflowState(row.task)} disabled={unavailable(row)} onChange={e => void move(row, e.target.value as WorkflowState)}>
        {WORKFLOW_STATES.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
      </select></div>
    {!!(buffers[row.path]?.dirty || buffers[row.path]?.conflict) && <span className="panel-meta">Waiting for the note to save</span>}
  </article>;
  return <div className="workspace-page task-board" aria-busy={busy}>
    <header className="board-toolbar"><h1>Task board</h1><input type="search" aria-label="Filter board tasks" placeholder="Find a task…" value={search} onChange={e => setSearch(e.target.value)} />
      <select aria-label="Board folder" value={folder} onChange={e => setFolder(e.target.value)}><option value="">All folders</option>{folders.map(f => <option key={f} value={f}>{f}</option>)}</select>
      <button onClick={() => { setError(null); setRefresh(n => n + 1); }}>Refresh</button></header>
    <p className="panel-meta">Drag a card to change its state, or use its state menu. Subtasks stay grouped under their parent.</p>
    <div role="status" aria-live="polite">{busy && <p>Saving task state…</p>}{error && <p className="error-text">{error} Refresh the board before trying again.</p>}</div>
    {result && result.total > result.rows.length && <p className="error-text">Showing {result.rows.length} of {result.total} tasks. Some groups may be incomplete.</p>}
    {!result && !error && <p>Loading tasks…</p>}
    <div className="board-scroll"><div className="board-grid">
      <div className="board-headings">{WORKFLOW_STATES.map((s, i) => <h2 key={s.id}>{s.title}<span className="panel-meta">{totals[i]}</span></h2>)}</div>
      {groups.map(g => <section className="board-group" key={taskKey(g.root)} aria-label={g.standalone ? "Other tasks" : g.root.task.text}>
        {!g.standalone && g.tasks.length > 1 && <header className="board-group-title"><strong>{g.root.task.text}</strong><span className="panel-meta">{g.tasks.slice(1).filter(r => r.task.status === "done").length}/{g.tasks.length - 1} subtasks done</span></header>}
        <div className="board-lane">{WORKFLOW_STATES.map(s => {
          const target = `${taskKey(g.root)}:${s.id}`;
          return <div className={`board-column ${dropTarget === target ? "drop-target" : ""}`} key={s.id} aria-label={`${g.standalone ? "Other tasks" : g.root.task.text}: ${s.title}`}
            onDragOver={e => { if (dragged && !unavailable(dragged) && e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropTarget(target); } }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null); }}
            onDrop={e => { e.preventDefault(); if (dragged && e.dataTransfer.getData(DRAG_TYPE) === taskKey(dragged)) void move(dragged, s.id); setDropTarget(null); }}>
            {g.tasks.filter(r => workflowState(r.task) === s.id).map(r => card(r, !g.standalone && g.tasks.length > 1 && r.task.line === g.root.task.line))}
          </div>;
        })}</div>
      </section>)}
    </div></div>
    {result && !groups.length && <p>No tasks match this board.</p>}
  </div>;
}
