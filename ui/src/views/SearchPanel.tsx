import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { api } from "../ipc/api";
import type { SearchHit } from "../ipc/types";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { useUi } from "../state/ui";

/** Renders `**match**` markers from the core as highlighted text. */
export function Snippet({ text }: { text: string }) {
  const parts = text.split("**");
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
    </>
  );
}

export function SearchPanel() {
  const query = useUi((s) => s.searchQuery);
  const setQuery = useUi((s) => s.setSearchQuery);
  const focusTick = useUi((s) => s.searchFocus);
  const revision = useVault((s) => s.revision);
  const indexing = useVault((s) => s.indexing);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [took, setTook] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusTick]);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      setTook(null);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      const start = performance.now();
      try {
        const res = await api.search(query, 100);
        if (live) {
          setHits(res);
          setTook(performance.now() - start);
        }
      } catch {
        if (live) setHits([]);
      }
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, revision]);

  return (
    <div className="panel">
      <label className="search-box">
        <Search size={14} />
        <input
          ref={input}
          placeholder="Search notes…  (tag:x  path:folder  “exact phrase”)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits[0]) void useWorkspace.getState().open(hits[0].path, { newTab: e.metaKey });
            if (e.key === "Escape") setQuery("");
          }}
        />
      </label>
      <div className="panel-meta">
        {indexing ? `Indexing ${indexing.done} / ${indexing.total}…` : query.trim() && took !== null ? `${hits.length} result${hits.length === 1 ? "" : "s"} · ${Math.round(took)} ms` : ""}
      </div>
      <div className="results">
        {hits.map((h) => (
          <button
            key={h.path}
            className="result"
            onClick={(e) => void useWorkspace.getState().open(h.path, { newTab: e.metaKey })}
            title={h.path}
          >
            <span className="result-title">{h.title}</span>
            {h.path.includes("/") && <span className="result-path">{h.path}</span>}
            {h.snippet && (
              <span className="result-snippet">
                <Snippet text={h.snippet} />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
