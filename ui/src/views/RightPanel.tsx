import { useEffect, useMemo, useState } from "react";
import { api } from "../ipc/api";
import type { Backlink } from "../ipc/types";
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
