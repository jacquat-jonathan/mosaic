// The frontmatter of a note as a form: lists as chips, checkboxes, dates, numbers and text. Each change
// rewrites only that property in the YAML (see properties.ts).

import { useState, type KeyboardEvent } from "react";
import { Code, Plus, X } from "lucide-react";
import { emptyValue, readProps, removeProp, renameProp, setProp, type Prop, type PropKind } from "./properties";

const KINDS: { kind: PropKind; label: string }[] = [
  { kind: "text", label: "Text" },
  { kind: "list", label: "List" },
  { kind: "date", label: "Date" },
  { kind: "checkbox", label: "Checkbox" },
  { kind: "number", label: "Number" },
];

export function PropertiesEditor({ yaml, onChange, onEditSource }: { yaml: string; onChange(yaml: string): void; onEditSource(): void }) {
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  let props: Prop[] = [];
  try {
    props = readProps(yaml);
  } catch (e) {
    return (
      <div className="cm-properties props-invalid">
        <span className="cm-render-error">The properties aren't valid YAML: {(e as Error).message}</span>
        <button className="props-link" onClick={onEditSource}>
          Edit as YAML
        </button>
      </div>
    );
  }
  const apply = (f: (y: string) => string) => {
    try {
      setError(null);
      onChange(f(yaml));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="cm-properties props-form">
      {props.map((p) => (
        <div key={p.key} className="cm-prop">
          <KeyField name={p.key} onRename={(to) => apply((y) => renameProp(y, p.key, to))} />
          <div className="cm-prop-value">
            <ValueField prop={p} onSet={(v) => apply((y) => setProp(y, p.key, v))} onEditSource={onEditSource} />
          </div>
          <button className="props-remove" aria-label={`Remove ${p.key}`} title="Remove this property" onClick={() => apply((y) => removeProp(y, p.key))}>
            <X size={13} />
          </button>
        </div>
      ))}
      {adding && (
        <AddProperty
          taken={props.map((p) => p.key)}
          onAdd={(key, kind) => {
            setAdding(false);
            apply((y) => setProp(y, key, emptyValue(kind)));
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {error && <div className="cm-render-error">{error}</div>}
      <div className="props-actions">
        <button className="props-link" onClick={() => setAdding(true)}>
          <Plus size={13} /> Add property
        </button>
        <button className="props-link" onClick={onEditSource} title="Edit the frontmatter as YAML">
          <Code size={13} /> Edit as YAML
        </button>
      </div>
    </div>
  );
}

function KeyField({ name, onRename }: { name: string; onRename(to: string): void }) {
  const [value, setValue] = useState(name);
  const commit = () => (value.trim() && value !== name ? onRename(value.trim()) : setValue(name));
  return (
    <input
      className="cm-prop-key props-input"
      aria-label="Property name"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => enterBlurs(e)}
    />
  );
}

/** Enter commits (by leaving the field); Escape too. */
function enterBlurs(e: KeyboardEvent<HTMLInputElement>) {
  if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur();
}

function ValueField({ prop, onSet, onEditSource }: { prop: Prop; onSet(v: unknown): void; onEditSource(): void }) {
  switch (prop.kind) {
    case "checkbox":
      return <input type="checkbox" aria-label={prop.key} checked={!!prop.value} onChange={(e) => onSet(e.target.checked)} />;
    case "date":
      return <input type="date" className="props-input" aria-label={prop.key} value={String(prop.value ?? "").slice(0, 10)} onChange={(e) => e.target.value && onSet(e.target.value)} />;
    case "number":
      return <TextField value={String(prop.value ?? "")} label={prop.key} type="number" onCommit={(t) => onSet(t === "" ? null : Number(t))} />;
    case "list":
      return <ListField items={(prop.value as unknown[]).map((v) => String(v ?? ""))} label={prop.key} onSet={onSet} />;
    case "text":
      return <TextField value={prop.value === null ? "" : String(prop.value)} label={prop.key} onCommit={(t) => onSet(t)} />;
    default:
      return (
        <button className="props-link" onClick={onEditSource} title="This value is nested; edit it as YAML">
          {JSON.stringify(prop.value)}
        </button>
      );
  }
}

function TextField({ value, label, type = "text", onCommit }: { value: string; label: string; type?: string; onCommit(v: string): void }) {
  const [text, setText] = useState(value);
  return (
    <input
      type={type}
      className="props-input"
      aria-label={label}
      value={text}
      placeholder="Empty"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={enterBlurs}
    />
  );
}

function ListField({ items, label, onSet }: { items: string[]; label: string; onSet(v: string[]): void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) onSet([...items, ...parts]);
    setDraft("");
  };
  return (
    <div className="props-chips">
      {items.map((item, i) => (
        <span key={`${item}-${i}`} className="cm-prop-pill">
          {item}
          <button aria-label={`Remove ${item} from ${label}`} onClick={() => onSet(items.filter((_, j) => j !== i))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        className="props-input props-chip-input"
        aria-label={`Add to ${label}`}
        value={draft}
        placeholder="Add…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
        }}
      />
    </div>
  );
}

function AddProperty({ taken, onAdd, onCancel }: { taken: string[]; onAdd(key: string, kind: PropKind): void; onCancel(): void }) {
  const [key, setKey] = useState("");
  const [kind, setKind] = useState<PropKind>("text");
  const clash = taken.includes(key.trim());
  return (
    <div className="cm-prop props-add">
      <input
        className="cm-prop-key props-input"
        aria-label="New property name"
        autoFocus
        value={key}
        placeholder="name"
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && key.trim() && !clash) onAdd(key.trim(), kind);
          if (e.key === "Escape") onCancel();
        }}
      />
      <select aria-label="Type" value={kind} onChange={(e) => setKind(e.target.value as PropKind)}>
        {KINDS.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.label}
          </option>
        ))}
      </select>
      <button className="props-link" disabled={!key.trim() || clash} onClick={() => onAdd(key.trim(), kind)}>
        {clash ? "Name taken" : "Add"}
      </button>
    </div>
  );
}
