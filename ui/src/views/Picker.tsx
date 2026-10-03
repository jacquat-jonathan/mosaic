import { useEffect, useMemo, useRef, useState } from "react";
import { useUi, type Picker as PickerSpec, type PickerItem } from "../state/ui";
import { fuzzyScore } from "./QuickSwitcher";

/** Fuzzy-filtered list in a modal: command palette, "Move to…" folder picker. */
export function Picker() {
  const picker = useUi((s) => s.picker);
  if (!picker) return null;
  return <PickerDialog key={picker.placeholder} spec={picker} />;
}

export function filterItems(items: PickerItem[], q: string): PickerItem[] {
  if (!q.trim()) return items;
  return items
    .map((it) => ({ it, s: Math.max(fuzzyScore(q, it.label) * 2, fuzzyScore(q, `${it.detail ?? ""} ${it.label}`)) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((r) => r.it);
}

function PickerDialog({ spec }: { spec: PickerSpec }) {
  const close = () => useUi.getState().closePicker();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => input.current?.focus(), []);

  const results = useMemo(() => filterItems(spec.items, q), [spec.items, q]);

  useEffect(() => {
    list.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (i: number) => {
    const item = results[i];
    if (!item) return;
    close();
    spec.onPick(item);
  };

  return (
    <div className="modal-backdrop top picker" onMouseDown={close}>
      <div className="switcher" role="dialog" aria-label={spec.placeholder} onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          placeholder={spec.placeholder}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(sel);
            }
          }}
        />
        <div className="switcher-results" ref={list} role="listbox">
          {results.map((it, i) => (
            <button
              key={it.id}
              role="option"
              aria-selected={i === sel}
              className={i === sel ? "selected" : ""}
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(i)}
            >
              <span className="switcher-name">{it.label}</span>
              {it.detail && <span className="picker-detail">{it.detail}</span>}
              {it.shortcut && <kbd className="picker-kbd">{it.shortcut}</kbd>}
            </button>
          ))}
          {results.length === 0 && <p className="picker-empty">No matches</p>}
        </div>
        {spec.hint && <div className="switcher-hint">{spec.hint}</div>}
      </div>
    </div>
  );
}
