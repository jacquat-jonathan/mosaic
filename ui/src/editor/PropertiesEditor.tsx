// The frontmatter of a note as a form: lists as chips, checkboxes, dates, numbers and text. Each change
// rewrites only that property in the YAML (see properties.ts).

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Code, Plus, X } from "lucide-react";
import { ADD_PROPERTY_EVENT, takeAddOnMount } from "./noteViews";
import { emptyValue, readProps, removeProp, renameProp, setProp, type Prop, type PropKind } from "./properties";

import { Badge, Button, IconButton, Notice, Switch } from "../design-system/components";
import { DesignSystemScope } from "../views/DesignSystemScope";
import "./propertiesEditor.css";

const KINDS: { kind: PropKind; label: string }[] = [
  { kind: "text", label: "Text" },
  { kind: "list", label: "List" },
  { kind: "date", label: "Date" },
  { kind: "checkbox", label: "Checkbox" },
  { kind: "number", label: "Number" },
];

export function PropertiesEditor({
  yaml,
  onChange,
  onEditSource,
  inheritScope = false,
}: {
  yaml: string;
  inheritScope?: boolean;
  onChange(yaml: string): void;
  onEditSource(): void;
}) {
  const Container = inheritScope ? "div" : DesignSystemScope;
  const addButton = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  // "Add a property" (⌘;) opens the form, also on a panel it just created.
  const [adding, setAdding] = useState(takeAddOnMount);
  useEffect(() => {
    const open = () => {
      takeAddOnMount();
      setAdding(true);
    };
    window.addEventListener(ADD_PROPERTY_EVENT, open);
    return () => window.removeEventListener(ADD_PROPERTY_EVENT, open);
  }, []);
  let props: Prop[] = [];
  try {
    props = readProps(yaml);
  } catch (e) {
    return (
      <Container className="cm-properties props-form props-invalid" role="group" aria-label="Note properties">
        <Notice tone="error">The properties aren't valid YAML: {(e as Error).message}</Notice>
        <Button className="props-link" onClick={onEditSource}>
          Edit as YAML
        </Button>
      </Container>
    );
  }
  const apply = (f: (y: string) => string) => {
    try {
      setError(null);
      onChange(f(yaml));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  return (
    <Container className="cm-properties props-form" role="group" aria-label="Note properties">
      {props.map((p) => (
        <div key={p.key} className="cm-prop">
          <KeyField name={p.key} onRename={(to) => apply((y) => renameProp(y, p.key, to))} />
          <div className="cm-prop-value">
            <ValueField prop={p} onSet={(v) => apply((y) => setProp(y, p.key, v))} onEditSource={onEditSource} />
          </div>
          <IconButton
            className="props-remove"
            label={`Remove ${p.key}`}
            title="Remove this property"
            onClick={(event) => {
              const region = focusRegion(event.currentTarget);
              if (apply((y) => removeProp(y, p.key))) focusAfterChange(region, "Add property");
            }}
          >
            <X aria-hidden="true" />
          </IconButton>
        </div>
      ))}
      {adding && (
        <AddProperty
          taken={props.map((p) => p.key)}
          onAdd={(key, kind) => {
            const region = focusRegion(addButton.current);
            if (apply((y) => setProp(y, key, emptyValue(kind)))) {
              setAdding(false);
              focusAfterChange(region, key);
            }
          }}
          onCancel={() => {
            setAdding(false);
            requestAnimationFrame(() => addButton.current?.focus());
          }}
        />
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="props-actions">
        <Button ref={addButton} className="props-link" aria-label="Add property" onClick={() => setAdding(true)}>
          <Plus aria-hidden="true" /> Add property
        </Button>
        <Button className="props-link" onClick={onEditSource} title="Edit the frontmatter as YAML">
          <Code size={13} /> Edit as YAML
        </Button>
      </div>
    </Container>
  );
}

function focusRegion(element: HTMLElement | null) {
  return element?.closest(".right-panel, .cm-editor") ?? element?.parentElement;
}
function focusAfterChange(region: Element | null | undefined, label: string) {
  requestAnimationFrame(() => {
    const fields = [...(region?.querySelectorAll<HTMLElement>("[aria-label]") ?? [])];
    (
      fields.find((field) => field.getAttribute("aria-label") === label) ??
      fields.find((field) => field.getAttribute("aria-label") === "Add property")
    )?.focus();
  });
}

function KeyField({ name, onRename }: { name: string; onRename(to: string): void }) {
  const [value, setValue] = useState(name);
  const commit = () => (value.trim() && value !== name ? onRename(value.trim()) : setValue(name));
  return (
    <input
      className="mds-input cm-prop-key props-input"
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
      return <Switch label={prop.key} checked={!!prop.value} onCheckedChange={onSet} />;
    case "date":
      return (
        <input
          type="date"
          className="mds-input props-input"
          aria-label={prop.key}
          value={String(prop.value ?? "").slice(0, 10)}
          onChange={(e) => e.target.value && onSet(e.target.value)}
        />
      );
    case "number":
      return (
        <TextField
          value={String(prop.value ?? "")}
          label={prop.key}
          type="number"
          onCommit={(t) => onSet(t === "" ? null : Number(t))}
        />
      );
    case "list":
      return <ListField items={(prop.value as unknown[]).map((v) => String(v ?? ""))} label={prop.key} onSet={onSet} />;
    case "text":
      return (
        <TextField value={prop.value === null ? "" : String(prop.value)} label={prop.key} onCommit={(t) => onSet(t)} />
      );
    default:
      return (
        <Button className="props-link" onClick={onEditSource} title="This value is nested; edit it as YAML">
          {JSON.stringify(prop.value)}
        </Button>
      );
  }
}

function TextField({
  value,
  label,
  type = "text",
  onCommit,
}: {
  value: string;
  label: string;
  type?: string;
  onCommit(v: string): void;
}) {
  const [text, setText] = useState(value);
  return (
    <input
      type={type}
      className="mds-input props-input"
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
    const parts = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) onSet([...items, ...parts]);
    setDraft("");
  };
  return (
    <div className="props-chips">
      {items.map((item, i) => (
        <Badge key={`${item}-${i}`} className="cm-prop-pill">
          {item}
          <IconButton
            label={`Remove ${item} from ${label}`}
            onClick={(event) => {
              const region = focusRegion(event.currentTarget);
              onSet(items.filter((_, j) => j !== i));
              focusAfterChange(region, `Add to ${label}`);
            }}
          >
            <X aria-hidden="true" />
          </IconButton>
        </Badge>
      ))}
      <input
        className="mds-input props-input props-chip-input"
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

function AddProperty({
  taken,
  onAdd,
  onCancel,
}: {
  taken: string[];
  onAdd(key: string, kind: PropKind): void;
  onCancel(): void;
}) {
  const [key, setKey] = useState("");
  const [kind, setKind] = useState<PropKind>("text");
  const clash = taken.includes(key.trim());
  const errorId = useId();
  return (
    <div className="cm-prop props-add">
      <input
        className="mds-input cm-prop-key props-input"
        aria-label="New property name"
        aria-invalid={clash}
        aria-describedby={clash ? errorId : undefined}
        autoFocus
        value={key}
        placeholder="name"
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && key.trim() && !clash) onAdd(key.trim(), kind);
          if (e.key === "Escape") onCancel();
        }}
      />
      <select
        className="mds-input"
        aria-label="Type"
        value={kind}
        onChange={(e) => setKind(e.target.value as PropKind)}
      >
        {KINDS.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.label}
          </option>
        ))}
      </select>
      <Button className="props-link" disabled={!key.trim() || clash} onClick={() => onAdd(key.trim(), kind)}>
        {clash ? "Name taken" : "Add"}
      </Button>
      {clash && (
        <span id={errorId} className="mds-field-error props-add-error" role="status">
          A property with this name already exists.
        </span>
      )}
    </div>
  );
}
