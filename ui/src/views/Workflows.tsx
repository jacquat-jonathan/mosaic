import { useEffect, useRef, useState } from "react";
import { parseDocument } from "yaml";
import { api } from "../ipc/api";
import { errorMessage, type Agent, type AgentRun, type Proposal } from "../ipc/types";
import { useAttention } from "../state/attention";
import { useReview } from "../state/review";
import { useUi } from "../state/ui";
import { parentOf, useVault, uniquePath } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { FRONTMATTER_RE } from "../editor/livePreview";
import { viewPath } from "./specialTabs";
import { vaultPrefs } from "../state/vaultPreferences";
import { registerDraft } from "../state/drafts";
import { FolderChoices } from "./FolderChoices";

export function pendingForRun(run: AgentRun | undefined, pending: Proposal[]) {
  if (!run) return [];
  return pending.filter(p => run.proposal_ids?.includes(p.id));
}
export function runState(run: AgentRun, needsReview = false) {
  return run.status === "running" ? "Running" : run.status === "failed" ? "Failed" : run.status === "skipped" ? "Skipped" : needsReview ? "Needs review" : "Successful";
}
export const eventFolder = (event: string) => /^created in\s+(.+)$/i.exec(event.trim())?.[1].replace(/^\/+|\/+$/g, "") ?? null;
export const matchesEventFolder = (path: string, folder: string) => path.toLowerCase().endsWith(".md") && (!folder || path.startsWith(`${folder}/`));
export function workflowTrigger(agent: Agent) {
  const triggers = [...(agent.schedule ? [agent.schedule] : []), ...(agent.on ?? [])];
  return triggers.length ? triggers.join(" · ") : "Manual";
}
export const workflowDeleteTarget = (agent: Agent) => agent.skill_folder ? parentOf(agent.path) : agent.path;
export function RunDetail({ id, compact = false }: { id: string; compact?: boolean }) {
  const run = useAttention(s => s.status?.runs.find(r => String(r.id) === id));
  const pending = useReview(s => s.pending);
  if (!run) return <p className="panel-meta">This run is unavailable.</p>;
  const proposals = pendingForRun(run, pending);
  return <div className={compact ? "context-content" : "workspace-page"}>
    <h2>{run.title}</h2><p className="state-label">{runState(run, proposals.length > 0)}</p>
    <p>{new Date(run.started * 1000).toLocaleString()}{run.late ? " · Started late" : ""}</p>
    <dl><dt>Trigger</dt><dd>{run.trigger || "Manual"}</dd>{run.model && <><dt>Model</dt><dd>{run.model}</dd></>}{(run.attempts ?? 1) > 1 && <><dt>Attempts</dt><dd>{run.attempts}</dd></>}{run.chain_id && <><dt>Workflow chain</dt><dd>Depth {run.chain_depth ?? 0} · {run.chain_id}</dd></>}</dl>
    <h3>Result</h3><div className="tessera-answer">{run.error || run.answer || "Working…"}</div>
    <h3>Changed files</h3>{run.changed_paths?.length ? run.changed_paths.map(path=><button key={path} onClick={()=>void useWorkspace.getState().open(path,{newTab:true})}>{path}</button>) : <p>No changed files recorded.</p>}
    {!!run.changes.length && <><h3>Tool activity</h3><ul>{run.changes.map((c,i) => <li key={i}>{c}</li>)}</ul></>}
    <h3>Review</h3><p>{run.proposals} proposals created during this run. {proposals.length} pending from this run.</p>
    <button onClick={() => useUi.getState().openView("activity")}>Open activity and reviews</button>
  </div>;
}
export function WorkflowContext({ name }: { name: string }) {
  const agent = useAttention(s => s.agents.find(a => a.name === name));
  const status = useAttention(s => s.status);
  const scheduled = status?.agents.find(a => a.name === name);
  const latest = status?.runs.find(r => r.agent === name);
  const pending = useReview(s => s.pending);
  if (!agent) return <p className="panel-meta">Workflow unavailable.</p>;
  const needsReview = status?.runs.some(r => r.agent === name && pendingForRun(r, pending).length);
  const automatic = !!agent.schedule || !!agent.on?.length;
  const state = scheduled?.running || latest?.status === "running" ? "Running" : scheduled?.queued ? "Queued" : scheduled?.paused || (automatic && status?.paused) ? "Paused" : scheduled?.error ? "Failed" : needsReview ? "Needs review" : latest ? runState(latest) : "Ready";
  return <div className="context-content"><h3>{agent.title}</h3><dl><dt>Agent</dt><dd>{agent.name}</dd><dt>Trigger</dt><dd>{workflowTrigger(agent)}</dd><dt>Model</dt><dd>{agent.model || "Claude Code default"}</dd><dt>Allowed folders</dt><dd>{agent.may_change.join(", ") || "All changes require review"}</dd><dt>Status</dt><dd>{state}</dd></dl><button onClick={() => void useWorkspace.getState().open(agent.path, { newTab: true })}>Edit source</button></div>;
}
export function Workflows({ name, runsOnly = false, agentsOnly = false }: { name?: string; runsOnly?: boolean; agentsOnly?: boolean }) {
  const { status, agents, error, refresh } = useAttention();
  const pending = useReview(s => s.pending);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const selected = agents.find(a => a.name === name);
  const act = async (id: string, work: () => Promise<unknown>) => { setBusy(id); setProblem(null); try { await work(); await refresh(); } catch(e) { setProblem(errorMessage(e)); } finally { setBusy(null); } };
  const testEvent = (agent: Agent) => {
    const folders = (agent.on ?? []).map(eventFolder).filter((f): f is string => f !== null);
    const notes = useVault.getState().entries.filter(e => !e.is_dir && folders.some(folder => matchesEventFolder(e.path, folder)));
    useUi.getState().openPicker({
      placeholder: "Choose an existing note for the test event",
      items: notes.map(n => ({ id: n.path, label: n.name, detail: n.path.includes("/") ? n.path : undefined })),
      hint: notes.length ? "↵ test trigger · esc cancel" : "No matching Markdown notes",
      onPick: item => void act(agent.name, async () => { const id = await api.tesseraTestEvent(agent.name, item.id); useUi.getState().openView("run", String(id)); }),
    });
  };
  const removeWorkflow = async (agent: Agent) => {
    const target = workflowDeleteTarget(agent);
    const ok = await useUi.getState().ask({
      title: `Delete “${agent.title}”?`,
      body: `${agent.skill_folder ? "Its agent folder" : "Its agent file"} will be moved to the macOS Trash and future automatic runs will stop. Existing run history will be kept.`,
      confirmLabel: "Delete workflow",
      danger: true,
    });
    if (!ok) return;
    setBusy(agent.name); setProblem(null);
    try {
      if (!(await useVault.getState().remove(target))) return;
      await api.mirrorAgents();
      await refresh();
      const tab = viewPath("workflow", agent.name);
      const ws = useWorkspace.getState();
      for (const pane of ws.panes) if (pane.tabs.includes(tab)) ws.closeTab(pane.id, tab);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  if (editing && selected) return <WorkflowForm agent={selected} onDone={() => { setEditing(false); void refresh(); }} />;
  const shown = name ? agents.filter(a => a.name === name) : agents;
  const runs = (status?.runs ?? []).filter(r => !name || r.agent === name);
  return <div className="workspace-page">
    <header className="workspace-heading"><div><h1>{selected?.title ?? (runsOnly ? "Runs" : agentsOnly ? "Agents" : "Workflows")}</h1><p>Repeatable work on your vault files. Schedules and events run while Mosaic is open.</p></div>
      {!runsOnly && <button className="primary" onClick={() => selected ? setEditing(true) : useUi.getState().openView("new-workflow")}>{selected ? "Edit workflow" : "Create workflow"}</button>}
      {!name && !agentsOnly && <button disabled={!!busy || !status} onClick={() => void act("all", () => api.tesseraPauseAll(!status?.paused))}>{status?.paused ? "Resume automations" : "Pause automations"}</button>}
    </header>
    {(problem || error) && <p className="error-text" role="alert">{problem || error}</p>}
    {status?.paused && <p className="notice warn">All automatic workflows are paused. Manual runs and test triggers are available.</p>}
    {!runsOnly && <div className="workflow-grid">{shown.map(a => {
      const schedule = status?.agents.find(x => x.name === a.name);
      const latest = status?.runs.find(r => r.agent === a.name);
      const running = schedule?.running || latest?.status === "running";
      const automatic = !!a.schedule || !!a.on?.length;
      const needsReview = (status?.runs.filter(r => r.agent === a.name).some(r => pendingForRun(r, pending).length) ?? false);
      const state = running ? "Running" : schedule?.queued ? `Queued · ${schedule.queued}` : schedule?.paused || (automatic && status?.paused) ? "Paused" : schedule?.error ? "Failed" : needsReview ? "Needs review" : latest ? runState(latest) : "Ready";
      return <article className="workflow-card" key={a.name}>
        <header><button className="workflow-title" onClick={() => useUi.getState().openView("workflow", a.name)}>{a.title}</button><span className="state-label">{state}</span></header>
        <p>{a.description}</p><dl><dt>Agent</dt><dd>{a.name}</dd><dt>Trigger</dt><dd>{workflowTrigger(a)}</dd><dt>Model</dt><dd>{a.model || "Claude Code default"}</dd><dt>May change without review</dt><dd>{a.may_change.join(", ") || "None — review every change"}</dd></dl>
        {schedule?.error && <p className="error-text">{schedule.error}</p>}
        {latest && <button onClick={() => useUi.getState().openView("run", String(latest.id))}>Last run: {runState(latest, needsReview)} · {new Date(latest.started * 1000).toLocaleString()}</button>}
        <footer><button className="primary" disabled={running || !!busy || !!schedule?.error} onClick={() => void act(a.name, async () => { const id = await api.tesseraRun(a.name); useUi.getState().openView("run", String(id)); })}>Run now</button>
          {!!a.on?.length && <button disabled={running || !!busy || !!schedule?.error} onClick={() => testEvent(a)}>Test trigger…</button>}
          {automatic && <button disabled={!!busy} onClick={() => void act(a.name, () => api.tesseraPauseAgent(a.name, !schedule?.paused))}>{schedule?.paused ? "Resume" : "Pause"}</button>}
          <button aria-label={`More actions for ${a.title}`} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); useUi.getState().showMenu(r.left,r.bottom,[{label:"Edit workflow",action:()=>{useUi.getState().openView("workflow",a.name); if(name === a.name) setEditing(true);}},{label:"Edit agent source",action:()=>void useWorkspace.getState().open(a.path,{newTab:true})},...(a.on?.length ? [{label:"Test event trigger…",action:()=>testEvent(a)}] : []),{separator:true,label:""},{label:"Delete workflow…",danger:true,disabled:!!running,detail:running ? "Wait for the current run to finish" : undefined,action:()=>void removeWorkflow(a)}]); }}>⋯</button>
        </footer>
      </article>;
    })}</div>}
    {!runsOnly && !shown.length && <p className="panel-meta">{status ? "No workflows yet. Create one to choose an agent, trigger, and folders." : "Loading workflows…"}</p>}
    {!agentsOnly && <section><h2>Recent runs</h2>{!runs.length && <p>No runs yet.</p>}{runs.map(r => <button className="run-row" key={r.id} onClick={() => useUi.getState().openView("run",String(r.id))}><strong>{r.title}</strong><time>{new Date(r.started * 1000).toLocaleString()}</time><span>{runState(r, pendingForRun(r, pending).length > 0)}</span></button>)}</section>}
  </div>;
}

export function workflowContent(source: string, schedule: string | null, events: string[], model: string | null, folders: string[], instructions?: string): string {
  const fm = FRONTMATTER_RE.exec(source);
  const doc = parseDocument(fm?.[1] ?? "");
  if (doc.errors.length) throw new Error("Fix the agent's YAML in its source before using the form.");
  if (schedule) doc.set("schedule", schedule); else doc.delete("schedule");
  if (events.length === 1) doc.set("on", events[0]); else if (events.length) doc.set("on", events); else doc.delete("on");
  if (model) doc.set("model", model); else doc.delete("model");
  doc.delete("may_change"); doc.set("may-change", folders);
  const body = instructions === undefined ? source.slice(fm?.[0].length ?? 0) : `\n${instructions.trim()}\n`;
  return `---\n${doc.toString()}---${instructions === undefined && fm ? body : `\n${body}`}`;
}
export function WorkflowForm({ agent, onDone }: { agent?: Agent; onDone?: () => void }) {
  const agents = useAttention(s => s.agents);
  const [dirty, setDirty] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const [choice, setChoice] = useState(agent?.name ?? "");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [source, setSource] = useState<{ path: string; content: string; hash: string } | null>(null);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleKind, setScheduleKind] = useState("daily");
  const [time, setTime] = useState("08:00");
  const [interval, setInterval] = useState(2);
  const [custom, setCustom] = useState("");
  const [eventFolders, setEventFolders] = useState<string[]>([]);
  const [eventEnabled, setEventEnabled] = useState(false);
  const [otherEvents, setOtherEvents] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [review, setReview] = useState(true);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const chosen = agents.find(a => a.name === choice);
  const root = useVault(s => s.vault?.root);
  const [initialRoot] = useState(root);
  const [draftPath] = useState(() => agent ? viewPath("workflow", agent.name) : "mosaic:new-workflow");
  const unregister = useRef<(() => void) | null>(null);
  const discard = async () => {
    if (!dirty) return true;
    const ok = await useUi.getState().ask({ title: "Discard workflow changes?", body: "Your draft has not been saved. The agent source is unchanged.", confirmLabel: "Discard changes", danger: true });
    if (ok) { setDirty(false); unregister.current?.(); }
    return ok;
  };
  useEffect(() => {
    if (!dirty) return;
    unregister.current = registerDraft(draftPath, discard);
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { unregister.current?.(); window.removeEventListener("beforeunload", beforeUnload); };
  }, [dirty, draftPath]);
  useEffect(() => {
    let live = true; setSource(null); setError(null);
    if (!chosen) { setInstructions(""); setScheduleEnabled(false); setScheduleKind("daily"); setEventEnabled(false); setEventFolders([]); setOtherEvents([]); setModel(""); setAllowed([]); setReview(true); return; }
    setInstructions(chosen.instructions); setAllowed(chosen.may_change); setReview(!chosen.may_change.length);
    setModel(chosen.model ?? "");
    const parsedEvents=(chosen.on ?? []).map(raw=>[raw,eventFolder(raw)] as const);
    setEventFolders(parsedEvents.map(([,folder])=>folder).filter((f): f is string => f !== null));
    setEventEnabled(parsedEvents.some(([,folder]) => folder !== null));
    setOtherEvents(parsedEvents.filter(([,folder])=>folder === null).map(([raw])=>raw));
    const parts = /^(daily|weekdays|mon|tue|wed|thu|fri|sat|sun) (\d{2}:\d{2})$/.exec(chosen.schedule ?? "");
    const every = /^every (\d+)h$/.exec(chosen.schedule ?? "");
    setScheduleEnabled(!!chosen.schedule);
    if (parts) { setScheduleKind(parts[1]); setTime(parts[2]); } else if (every) { setScheduleKind("every"); setInterval(Number(every[1])); } else if (chosen.schedule) { setScheduleKind("custom"); setCustom(chosen.schedule); } else setScheduleKind("daily");
    void api.read(chosen.path).then(f => { if(live) setSource({path:chosen.path, content:f.content ?? "", hash:f.hash}); },e => live && setError(errorMessage(e)));
    return () => { live = false; };
  }, [chosen?.path]);
  const save = async () => {
    if (saveLock.current) return;
    saveLock.current = true;
    setSaving(true); setError(null);
    try {
      if (useVault.getState().vault?.root !== initialRoot) throw new Error("The vault changed. Reopen the workflow form.");
      if (!instructions.trim()) throw new Error("Describe what the agent should do.");
      if (!review && !allowed.length) throw new Error("Choose at least one folder, or review every change.");
      const schedule = !scheduleEnabled ? null : scheduleKind === "custom" ? custom : scheduleKind === "every" ? `every ${interval}h` : `${scheduleKind} ${time}`;
      if (scheduleEnabled && !schedule?.trim()) throw new Error("Choose a schedule or disable scheduled runs.");
      if (scheduleEnabled && scheduleKind !== "custom" && scheduleKind !== "every" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Choose a valid time.");
      if (scheduleEnabled && scheduleKind === "every" && (!Number.isInteger(interval) || interval < 1 || interval > 8760)) throw new Error("Choose an interval between 1 and 8760 hours.");
      if (eventEnabled && !eventFolders.length) throw new Error("Choose at least one event folder, including Vault root if needed.");
      const events=[...otherEvents,...(eventEnabled ? eventFolders : []).map(folder=>`created in ${folder ? `${folder}/` : "/"}`)];
      let path: string;
      if (chosen) {
        if (!source || source.path !== chosen.path) throw new Error("Wait for the agent to load.");
        const buffer = useWorkspace.getState().buffers[chosen.path];
        if (buffer?.dirty || buffer?.conflict) throw new Error("Save the open agent source and resolve conflicts before editing its workflow.");
        await api.write(chosen.path, workflowContent(source.content, schedule, events, model || null, review ? [] : allowed, instructions === chosen.instructions ? undefined : instructions), source.hash, initialRoot); path = chosen.path;
        await useWorkspace.getState().externalChange(path);
      } else {
        const name = title.trim(); if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error("Enter a title without file path characters.");
        path = uniquePath(new Set(useVault.getState().entries.map(e=>e.path.toLowerCase())), vaultPrefs().agents_folder, name, "md");
        await api.create(path, workflowContent("", schedule, events, model || null, review ? [] : allowed, instructions), initialRoot);
      }
      await api.mirrorAgents(); await useVault.getState().refresh(); await useAttention.getState().refresh();
      const result = useAttention.getState().agents.find(a => a.path === path);
      unregister.current?.(); setDirty(false);
      if (result) useUi.getState().openView("workflow", result.name);
      if (onDone) onDone(); else { const ws=useWorkspace.getState(); for(const p of ws.panes) if(p.tabs.includes("mosaic:new-workflow")) ws.closeTab(p.id,"mosaic:new-workflow"); }
    } catch(e) { setError(errorMessage(e)); form.current?.querySelector<HTMLElement>("[aria-invalid=true], :invalid")?.focus(); } finally { setSaving(false); saveLock.current = false; }
  };
  const cancel = async () => { if (await discard()) { if (onDone) onDone(); else useUi.getState().openView("workflows"); } };
  return <div className="workspace-page workflow-editor"><header><p className="panel-meta">WORKFLOW · {agent ? "EDIT" : "NEW"}</p><h1>{agent ? "Edit workflow" : "Create workflow"}</h1><p>Describe the work, choose when it runs, and keep control of every change.</p></header>
    <form ref={form} className="workflow-form" onChange={() => setDirty(true)} onSubmit={e => { e.preventDefault(); void save(); }}>
      <section className="workflow-section"><h2>The work</h2>
        {!agent && <label>Agent<select value={choice} onChange={e => { const value = e.target.value; void discard().then(ok => { if(ok) { setChoice(value); setDirty(false); } }); }}><option value="">Create a new agent</option>{agents.map(a=><option key={a.name} value={a.name}>{a.title}</option>)}</select></label>}
        {!choice ? <label>Name<input required value={title} onChange={e=>setTitle(e.target.value)} placeholder="Weekly review" /></label> : <p className="notice">Editing <strong>{chosen?.title}</strong> · <code>{chosen?.path}</code>. Saving updates this agent, not a copy.</p>}
        <label>Instructions<textarea required rows={10} value={instructions} onChange={e=>setInstructions(e.target.value)} placeholder="What should this agent do with your vault files?" /></label>
      </section>
      <section className="workflow-section"><h2>When to run</h2><p>Run now is always available. Automatic triggers run while Mosaic is open.</p>
        <label className="folder-choice"><input type="checkbox" checked={scheduleEnabled} onChange={e=>setScheduleEnabled(e.target.checked)} />Run on a schedule</label>
        {scheduleEnabled && <><label>Schedule<select value={scheduleKind} onChange={e=>setScheduleKind(e.target.value)}>{[["daily","Every day"],["weekdays","Weekdays"],["mon","Mondays"],["tue","Tuesdays"],["wed","Wednesdays"],["thu","Thursdays"],["fri","Fridays"],["sat","Saturdays"],["sun","Sundays"],["every","Every few hours"],...(custom ? [["custom",`Existing schedule: ${custom}`]] : [])].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
          {scheduleKind === "every" ? <label>Hours<input type="number" min={1} max={8760} value={interval} onChange={e=>setInterval(Number(e.target.value))} /></label> : scheduleKind !== "custom" && <label>Local time<input type="time" value={time} onChange={e=>setTime(e.target.value)} /></label>}</>}
        <label className="folder-choice"><input type="checkbox" checked={eventEnabled} onChange={e => setEventEnabled(e.target.checked)} />Run when a Markdown note is created</label>
        {eventEnabled && <><FolderChoices label="Event folders" root value={eventFolders} onChange={v => { setEventFolders(v); setDirty(true); }} /><p>Includes Markdown notes in subfolders.</p></>}
        {!scheduleEnabled && !eventEnabled && !otherEvents.length && <p className="notice">Manual only · Run it whenever you need it.</p>}
      </section>
      <section className="workflow-section"><h2>Execution & safety</h2>
        <label>Model<select value={model} onChange={e=>setModel(e.target.value)}><option value="">Claude Code default</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option><option value="haiku">Haiku</option>{model && !["sonnet","opus","haiku"].includes(model) && <option value={model}>{model}</option>}</select></label>
        <label>Review behavior<select value={review ? "all" : "folders"} onChange={e=>setReview(e.target.value === "all")}><option value="all">Review every change — recommended</option><option value="folders">Allow changes in selected folders</option></select></label>
        {!review && <FolderChoices label="May change without review" value={allowed} onChange={v => { setAllowed(v); setDirty(true); }} />}<p>Outside these folders, changes require review. Stricter vault permissions always apply.</p>
      </section>
      {chosen && <details className="workflow-section"><summary>Advanced · agent source</summary><p><code>{chosen.path}</code></p>{!!otherEvents.length && <p className="notice warn">Custom events preserved: {otherEvents.join(", ")}</p>}{scheduleKind === "custom" && <p>Custom schedule preserved: {custom}</p>}<button type="button" onClick={() => void useWorkspace.getState().open(chosen.path, {newTab:true})}>Edit source</button></details>}
      {root !== initialRoot && <p className="error-text" role="alert">The vault changed. Reopen this form before saving.</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <footer className="workflow-save"><div><strong>{scheduleEnabled || eventEnabled || otherEvents.length ? "Automatic triggers configured" : "Manual only"}</strong><p>{review ? "Review every change" : `${allowed.length} allowed folders`} · Saving does not run or unpause this workflow.</p></div><button type="button" disabled={saving} onClick={()=>void cancel()}>Cancel</button><button type="submit" className="primary" disabled={saving || root !== initialRoot || (!!choice && !source)}>{saving ? "Saving…" : agent ? "Save changes" : "Create workflow"}</button></footer>
    </form>
  </div>;
}
