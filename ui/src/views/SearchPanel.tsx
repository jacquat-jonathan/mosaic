import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { api } from "../ipc/api";
import { errorMessage, type SearchHit } from "../ipc/types";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { useUi } from "../state/ui";
import { Button, IconButton, Notice, TextField } from "../design-system/components";
import { DesignSystemScope } from "./DesignSystemScope";
import "./searchPanel.css";

/** Renders `**match**` markers from the core as highlighted text. */
export function Snippet({ text }: { text: string }) {
  const parts = text.split("**");
  return <>{parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}</>;
}

export function SearchPanel() {
  const query = useUi((s) => s.searchQuery),
    setQuery = useUi((s) => s.setSearchQuery);
  const focusTick = useUi((s) => s.searchFocus);
  const root = useVault((s) => s.vault?.root);
  const revision = useVault((s) => s.revision),
    indexing = useVault((s) => s.indexing);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [took, setTook] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [actionProblem, setActionProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const opening = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusTick]);
  useEffect(() => {
    let live = true;
    setHits([]);
    setTook(null);
    setProblem(null);
    setActionProblem(null);
    setLoading(!!query.trim());
    if (!query.trim()) return;
    const timer = setTimeout(async () => {
      const start = performance.now();
      try {
        const result = await api.search(query, 100);
        if (live) {
          setHits(result);
          setTook(performance.now() - start);
        }
      } catch (cause) {
        if (live) setProblem(errorMessage(cause));
      } finally {
        if (live) setLoading(false);
      }
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, root, revision, attempt]);
  const open = async (path: string, newTab: boolean) => {
    if (opening.current || loading || useVault.getState().vault?.root !== root) return;
    opening.current = true;
    setActionProblem(null);
    try {
      await useWorkspace.getState().open(path, { newTab });
    } catch (cause) {
      if (mounted.current && useVault.getState().vault?.root === root) setActionProblem(errorMessage(cause));
    } finally {
      opening.current = false;
    }
  };
  return (
    <DesignSystemScope className="search-panel" role="group" aria-label="Note search" aria-busy={loading}>
      <div className="search-controls">
        <TextField
          label="Search notes"
          ref={input}
          placeholder="Search notes…"
          hint="Use tag:x, path:folder, or an “exact phrase”."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && hits[0]) {
              event.preventDefault();
              void open(hits[0].path, event.metaKey);
            }
            if (event.key === "Escape") setQuery("");
          }}
        />
        {query.trim() && <BookmarkSearch key={root} query={query.trim()} root={root} />}
      </div>
      {problem && (
        <Notice tone="error">
          {problem}
          <Button
            variant="secondary"
            onClick={() => {
              input.current?.focus();
              setAttempt((value) => value + 1);
            }}
          >
            Retry search
          </Button>
        </Notice>
      )}
      {actionProblem && (
        <Notice tone="error">
          {actionProblem}
          <Button onClick={() => setActionProblem(null)}>Dismiss</Button>
        </Notice>
      )}
      <p className="search-summary mds-hint" role="status">
        {indexing
          ? `Indexing ${indexing.done} / ${indexing.total}…`
          : loading
            ? "Searching…"
            : query.trim() && took !== null
              ? `${hits.length} result${hits.length === 1 ? "" : "s"} · ${Math.round(took)} ms`
              : query.trim()
                ? ""
                : "Search note text, tags, or paths."}
      </p>
      <div className="search-results" role="list" aria-label="Search results">
        {!loading && !problem && query.trim() && took !== null && !hits.length && (
          <p className="mds-hint">No notes match this search.</p>
        )}
        {hits.map((hit) => (
          <div role="listitem" key={hit.path}>
            <Button className="search-result" onClick={(event) => void open(hit.path, event.metaKey)} title={hit.path}>
              <span className="search-result-title">{hit.title}</span>
              {hit.path.includes("/") && <span className="search-result-path">{hit.path}</span>}
              {hit.snippet && (
                <span className="search-result-snippet">
                  <Snippet text={hit.snippet} />
                </span>
              )}
            </Button>
          </div>
        ))}
      </div>
    </DesignSystemScope>
  );
}

function BookmarkSearch({ query, root }: { query: string; root: string | undefined }) {
  const key = `search:${query}`;
  const saved = useVault((s) => s.bookmarks.includes(key));
  const [busy, setBusy] = useState(false),
    [problem, setProblem] = useState<string | null>(null);
  const mounted = useRef(true),
    lock = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const toggle = async () => {
    if (lock.current || useVault.getState().vault?.root !== root) return;
    lock.current = true;
    setBusy(true);
    setProblem(null);
    const paths = useVault.getState().bookmarks;
    const next = saved ? paths.filter((path) => path !== key) : [...paths, key];
    try {
      await api.setBookmarks(next);
      if (useVault.getState().vault?.root === root) useVault.setState({ bookmarks: next });
    } catch (cause) {
      if (mounted.current && useVault.getState().vault?.root === root)
        setProblem(`Could not save search “${query}”: ${errorMessage(cause)}`);
    } finally {
      lock.current = false;
      if (mounted.current && useVault.getState().vault?.root === root) {
        setBusy(false);
        requestAnimationFrame(() => {
          if (document.activeElement === document.body || document.activeElement === button.current)
            button.current?.focus({ preventScroll: true });
        });
      }
    }
  };
  return (
    <div className="search-save">
      <IconButton
        ref={button}
        label={saved ? "Remove this search from Bookmarks" : "Bookmark this search"}
        aria-pressed={saved}
        disabled={busy}
        onClick={() => void toggle()}
      >
        <Star aria-hidden="true" fill={saved ? "currentColor" : "none"} />
      </IconButton>
      {problem && <Notice tone="error">{problem}</Notice>}
    </div>
  );
}
