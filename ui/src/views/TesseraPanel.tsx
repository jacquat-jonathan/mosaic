import { useCallback, useEffect, useState } from "react";
import { Bot, CirclePause, CirclePlay, Play } from "lucide-react";
import { api, onTesseraChanged } from "../ipc/api";
import { errorMessage, type TesseraStatus } from "../ipc/types";

export function TesseraPanel() {
  const [status, setStatus] = useState<TesseraStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.tesseraStatus().then(setStatus, (e) => setError(errorMessage(e))), []);
  useEffect(() => { void load(); let off: (() => void) | undefined; void onTesseraChanged(load).then((f) => (off = f)); return () => off?.(); }, [load]);
  const act = async (work: Promise<unknown>) => { setError(null); try { await work; await load(); } catch (e) { setError(errorMessage(e)); } };
  if (!status) return <div className="tessera"><p className="panel-meta">Loading scheduled agents…</p></div>;
  return <div className="tessera">
    <div className="tessera-head">
      <div><strong>Tessera</strong><span>Scheduled agents run while Mosaic is open.</span></div>
      <button title={status.paused ? "Resume all schedules" : "Pause all schedules"} onClick={() => void act(api.tesseraPauseAll(!status.paused))}>
        {status.paused ? <CirclePlay size={15} /> : <CirclePause size={15} />}
      </button>
    </div>
    {error && <p className="error-text">{error}</p>}
    <section><h3>Schedules <span className="count">{status.agents.length}</span></h3>
      {!status.agents.length && <p className="panel-meta">Add <code>schedule: daily 08:00</code> to an agent in Agents/.</p>}
      {status.agents.map((a) => <div className={`tessera-agent ${a.paused || status.paused ? "paused" : ""}`} key={a.name}>
        <Bot size={14} /><div><strong>{a.title}</strong><span>{a.schedule}{a.error ? ` — ${a.error}` : ""}</span></div>
        <button title={a.paused ? "Resume schedule" : "Pause schedule"} onClick={() => void act(api.tesseraPauseAgent(a.name, !a.paused))}>{a.paused ? <CirclePlay size={14}/> : <CirclePause size={14}/>}</button>
        <button title="Run now" disabled={a.running || !!a.error} onClick={() => void act(api.tesseraRun(a.name))}><Play size={13}/></button>
      </div>)}
    </section>
    <section><h3>Run log <span className="count">{status.runs.length}</span></h3>
      {!status.runs.length && <p className="panel-meta">No agents have run yet.</p>}
      {status.runs.map((r) => <details className={`tessera-run ${r.status}`} key={r.id}>
        <summary><span>{r.title}{r.late ? " · late" : ""}</span><time>{new Date(r.started * 1000).toLocaleString()}</time><em>{r.status}{r.proposals ? ` · ${r.proposals} proposed` : ""}</em></summary>
        {r.changes.length > 0 && <ul>{r.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
        {r.answer && <div className="tessera-answer">{r.answer}</div>}{r.error && <div className="error-text">{r.error}</div>}
      </details>)}
    </section>
  </div>;
}
