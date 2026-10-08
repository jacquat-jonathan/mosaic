import { useEffect, useRef, useState } from "react";
import { api } from "../ipc/api";
import { errorMessage, type TemplateConfig, type TemplateList } from "../ipc/types";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { defaultTemplateConfig } from "../templates";

export function TemplatesSettings() {
  const root = useVault(s => s.vault?.root);
  return root ? <Editor key={root} root={root} /> : <p>Open a vault to configure templates.</p>;
}
function Editor({ root }: { root: string }) {
  const entries = useVault(s => s.entries), revision = useVault(s => s.revision);
  const [config, setConfig] = useState<TemplateConfig | null>(null);
  const [list, setList] = useState<TemplateList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [starters, setStarters] = useState<[string,string][] | null>(null);
  const dirty = useRef(false);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    let active = true;
    void api.templateConfig().then(c => { if(active && !dirty.current) { setConfig(c); setError(null); } }).catch(e=>{ if(active) setError(errorMessage(e)); });
    void api.templates().then(l=>{ if(active) setList(l); }).catch(()=>{});
    return ()=>{ active=false; };
  }, [root, revision]);
  const change = (c: TemplateConfig) => { dirty.current=true; setChanged(true); setConfig(c); setMessage(null); };
  const guard = () => useVault.getState().vault?.root === root;
  const save = async () => {
    if(!config || !guard()) return;
    setBusy(true); setError(null);
    try { await api.setTemplateConfig(config); dirty.current=false; setChanged(false); setMessage("Template settings saved for this vault."); await useVault.getState().refresh(); }
    catch(e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const folderExists = !!config && entries.some(e=>e.is_dir && e.path.toLowerCase()===config.folder.toLowerCase());
  const createFolder = async () => {
    if(!config || !guard()) return;
    setBusy(true);
    try { await api.mkdir(config.folder); await useVault.getState().refresh(); setError(null); } catch(e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const install = async () => {
    if(!config || !starters || !guard()) return;
    setBusy(true); setError(null);
    const results: string[] = [];
    try {
      if (!folderExists) await api.mkdir(config.folder);
      for(const [name,content] of starters) {
        if(!guard()) break;
        const path = `${config.folder}/${name}`;
        try { await api.create(path,content); results.push(`Added ${name}`); }
        catch(e) { if ((e as {code?: string}).code === "already_exists") results.push(`Kept existing ${name}`); else throw e; }
      }
      setMessage(results.join(" · ")); setStarters(null); await useVault.getState().refresh();
    } catch(e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  if(!config) return <>{error ? <><p className="error-text" role="alert">{error}</p><button onClick={()=>change(defaultTemplateConfig())}>Repair template settings</button></> : <p>Loading template settings…</p>}</>;
  const paths = list?.templates.map(t=>t.path) ?? [];
  return <div className="templates-settings">
    <p className="settings-note">Templates are ordinary Markdown notes. These settings apply to this vault and are shared with AI agents.</p>
    <label>Templates folder<input className="text-input" list="template-folders" value={config.folder} disabled={busy} onChange={e=>change({...config,folder:e.target.value.replace(/^\/+|\/+$/g,"")})} /></label>
    <datalist id="template-folders">{entries.filter(e=>e.is_dir).map(e=><option key={e.path} value={e.path}/>)}</datalist>
    {!folderExists && <div><p className="settings-note">The folder is missing. Selecting a location does not create it.</p><button disabled={busy || !config.folder} onClick={()=>void createFolder()}>Create templates folder</button></div>}
    <h3>Folder defaults</h3><p className="settings-note">Subfolders inherit the nearest default. Blank stops inheritance. Removing a rule restores inheritance.</p>
    {config.rules.map((r,i)=><div className="template-rule" key={i}>
      <label>Destination folder<select value={r.folder} disabled={busy} onChange={e=>change({...config,rules:config.rules.map((r,j)=>j===i?{...r,folder:e.target.value}:r)})}><option value="">Vault root</option>{entries.filter(e=>e.is_dir).map(e=><option key={e.path} value={e.path}>{e.path}</option>)}{r.folder && !entries.some(e=>e.is_dir&&e.path===r.folder)&&<option value={r.folder}>{r.folder} (missing)</option>}</select></label>
      <label>Default template<select value={r.template ?? ""} disabled={busy} onChange={e=>change({...config,rules:config.rules.map((r,j)=>j===i?{...r,template:e.target.value||null}:r)})}><option value="">Blank</option>{paths.map(p=><option key={p} value={p}>{p}</option>)}{r.template && !paths.includes(r.template)&&<option value={r.template}>{r.template} (missing or outside Templates folder)</option>}</select></label>
      <button aria-label={`Remove default for ${r.folder || "Vault root"}`} disabled={busy} onClick={()=>change({...config,rules:config.rules.filter((_,j)=>j!==i)})}>Remove</button>
    </div>)}
    <div className="button-row"><button disabled={busy} onClick={()=>change({...config,rules:[...config.rules,{folder:"",template:null}]})}>Add folder default</button><button className="primary" disabled={busy || !changed} onClick={()=>void save()}>Save template settings</button></div>
    {error && <p className="error-text" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <h3>Available templates</h3>
    {paths.length ? paths.map(p=><button className="template-source" key={p} onClick={()=>void useWorkspace.getState().open(p,{newTab:true})}>{p}</button>) : <p className="settings-note">No saved Markdown templates in this folder yet.</p>}
    <button disabled={busy || changed} onClick={()=>void api.templateStarters().then(setStarters).catch(e=>setError(errorMessage(e)))}>Preview starter templates</button>
    {changed && <p className="settings-note">Save your settings before adding starter templates.</p>}
    {starters && <section aria-label="Starter template previews"><h3>Starter templates</h3><p>These become editable notes. Existing filenames will be kept.</p>{starters.map(([n,c])=><details key={n}><summary>{n}</summary><pre className="template-preview">{c}</pre></details>)}<div className="button-row"><button disabled={busy} onClick={()=>setStarters(null)}>Cancel</button><button disabled={busy || changed} onClick={()=>void install()}>Add starter templates</button></div></section>}
  </div>;
}
