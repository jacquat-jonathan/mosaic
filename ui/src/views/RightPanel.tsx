import { useEffect, useMemo, useState } from "react";
import { api } from "../ipc/api";
import { errorMessage, type Backlink, type Mention } from "../ipc/types";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { parse as parseMarkdownHeadings } from "./outline";

/** Backlinks and outline of the active note. */
export function RightPanel() {
  const active = useWorkspace((s) => s.panes.find((p) => p.id === s.focused)?.active ?? null);
  const content = useWorkspace((s) => (active ? s.buffers[active]?.content : null));
  const revision = useVault((s) => s.revision);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);

  useEffect(() => {
    if (!active) {
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

  if (!active) return <aside className="right-panel"><div className="panel-meta">No file open.</div></aside>;
  return (
    <aside className="right-panel">
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
              <div key={i} className="outline-item" style={{ paddingLeft: (h.level - 1) * 12 }}>
                {h.text}
              </div>
            ))}
          </div>
        </section>
      )}
    </aside>
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
