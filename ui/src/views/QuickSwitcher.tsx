import { useMemo, useRef, useState, useEffect, useId } from "react";
import { useUi } from "../state/ui";
import { useVault, parentOf, baseName } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { displayName, kindIcon } from "./FileTree";
import { Button, Dialog, TextField } from "../design-system/components";
import { DesignSystemScope } from "./DesignSystemScope";
import "./searchOverlay.css";
import { newNote } from "../actions";

/** Subsequence match score: consecutive and word-start matches rank higher; -1 if no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return -1;
    score += i === prev + 1 ? 5 : 1;
    if (i === 0 || /[\s/_-]/.test(t[i - 1])) score += 3;
    prev = i;
    ti = i + 1;
  }
  return score - t.length * 0.01;
}

export function QuickSwitcher() {
  const open = useUi((s) => s.switcher);
  if (!open) return null;
  return <SwitcherDialog />;
}

function SwitcherDialog() {
  const close = () => useUi.getState().setSwitcher(false);
  const entries = useVault((s) => s.entries);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();

  const results = useMemo(() => {
    const files = entries.filter((e) => !e.is_dir);
    if (!q.trim())
      return files
        .slice()
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 30);
    return files
      .map((e) => ({ e, s: Math.max(fuzzyScore(q, displayName(e)) * 2, fuzzyScore(q, e.path)) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map((r) => r.e);
  }, [entries, q]);

  useEffect(() => {
    list.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel, results]);

  const choose = async (i: number, newTab: boolean) => {
    const target = results[i];
    close();
    if (target) await useWorkspace.getState().open(target.path, { newTab });
    else if (q.trim()) await newNote(parentOf(q.trim()), baseName(q.trim()), newTab);
  };

  return (
    <DesignSystemScope className="search-overlay-scope">
      <Dialog
        open
        title="Quick switcher"
        initialFocusRef={input}
        onClose={close}
        actions={<Button onClick={close}>Cancel</Button>}
      >
        <TextField
          label="Find or create a note"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results[sel] ? `${listId}-${sel}` : q.trim() ? `${listId}-create` : undefined}
          ref={input}
          value={q}
          placeholder="Find or create a note…"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.max(0, Math.min(s + 1, results.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              void choose(e.shiftKey ? -1 : sel, e.metaKey);
            }
          }}
        />
        <div id={listId} ref={list} className="search-overlay-results" role="listbox" aria-label="Notes">
          {results.map((e, i) => (
            <button
              key={e.path}
              type="button"
              role="option"
              id={`${listId}-${i}`}
              aria-selected={i === sel}
              tabIndex={-1}
              onMouseDown={(ev) => ev.preventDefault()}
              className={i === sel ? "selected" : ""}
              onMouseEnter={() => setSel(i)}
              onClick={(ev) => void choose(i, ev.metaKey)}
            >
              {kindIcon(e.kind, 14)}
              <span className="search-overlay-main">
                <span className="search-overlay-name">{displayName(e)}</span>
                <span className="search-overlay-detail">
                  {e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : ""}
                </span>
              </span>
            </button>
          ))}
          {results.length === 0 && q.trim() && (
            <button
              type="button"
              role="option"
              id={`${listId}-create`}
              aria-selected="true"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              className="selected"
              onClick={() => void choose(-1, false)}
            >
              Create “{q.trim()}”
            </button>
          )}
          {results.length === 0 && !q.trim() && (
            <p className="search-overlay-empty">No notes yet. Type a name to create one.</p>
          )}
        </div>
        <div className="mds-hint">↵ open · ⌘↵ new tab · ⇧↵ create · esc close</div>
      </Dialog>
    </DesignSystemScope>
  );
}
