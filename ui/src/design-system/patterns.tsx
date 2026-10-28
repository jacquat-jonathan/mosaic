import { useId, type ReactNode } from "react";
import {
  CheckCircle2,
  CalendarClock,
  Circle,
  CircleAlert,
  Clock3,
  Eye,
  FilePenLine,
  LoaderCircle,
  Pause,
  Plus,
  ShieldCheck,
  SkipForward,
  Square,
  Zap,
  X,
} from "lucide-react";
import { Badge, Button, IconButton } from "./components";

export type RunState = "ready" | "queued" | "running" | "paused" | "completed" | "needs-review" | "failed" | "skipped";
const states = {
  ready: { label: "Ready", icon: Circle },
  queued: { label: "Queued", icon: Clock3 },
  running: { label: "Running", icon: LoaderCircle },
  paused: { label: "Paused", icon: Pause },
  completed: { label: "Completed", icon: CheckCircle2 },
  "needs-review": { label: "Needs review", icon: Clock3 },
  failed: { label: "Failed", icon: CircleAlert },
  skipped: { label: "Skipped", icon: SkipForward },
};

export function StatusLabel({ state }: { state: RunState }) {
  const { label, icon: Icon } = states[state];
  return (
    <span className={`mds-status mds-status--${state}`}>
      <Icon size={15} aria-hidden="true" />
      {label}
    </span>
  );
}

export function WorkflowCard({
  title,
  description,
  state,
  trigger,
  input,
  output,
  reviewPolicy,
  metadata,
  lastRun,
  actions,
  onOpen,
  notice,
}: {
  title: string;
  description: string;
  state: RunState;
  trigger: { kind: "schedule" | "event" | "manual"; label: string };
  input: string;
  output: string;
  reviewPolicy: string;
  metadata: readonly { label: string; value: ReactNode }[];
  lastRun?: { state?: RunState; when: string; summary: string; action?: ReactNode };
  actions: ReactNode;
  onOpen?: () => void;
  notice?: ReactNode;
}) {
  const TriggerIcon = trigger.kind === "schedule" ? CalendarClock : trigger.kind === "event" ? Zap : Circle;
  return (
    <article className="mds-workflow-card" aria-label={title}>
      <header>
        <h3>
          {onOpen ? (
            <Button className="mds-workflow-title" onClick={onOpen}>
              {title}
            </Button>
          ) : (
            title
          )}
        </h3>
        <StatusLabel state={state} />
      </header>
      <p>{description}</p>
      <div className="mds-workflow-trigger">
        <TriggerIcon size={16} aria-hidden="true" />
        <span>{trigger.label}</span>
      </div>
      <dl className="mds-workflow-scope">
        <div>
          <dt>Reads</dt>
          <dd>{input}</dd>
        </div>
        <div>
          <dt>Produces</dt>
          <dd>{output}</dd>
        </div>
      </dl>
      <p className="mds-workflow-policy">
        <ShieldCheck size={15} aria-hidden="true" />
        <span>{reviewPolicy}</span>
      </p>
      {notice}
      {lastRun && (
        <div className="mds-workflow-last-run">
          <div>
            <span>Latest run</span>
            <span>{lastRun.when}</span>
          </div>
          {lastRun.state && <StatusLabel state={lastRun.state} />}
          <p>{lastRun.summary}</p>
          {lastRun.action}
        </div>
      )}
      <details className="mds-workflow-settings">
        <summary>Workflow settings</summary>
        <dl className="mds-metadata">
          {metadata.map(({ label, value }) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </details>
      <footer>{actions}</footer>
    </article>
  );
}

export type RunSummary = {
  id: string;
  title: string;
  state: RunState;
  trigger: string;
  model: string;
  started: string;
  dateTime: string;
  duration: string;
  note?: string;
};

export function RunsTable({
  runs,
  onOpenRun,
  selectedId,
  label = "Workflow runs preview",
}: {
  runs: readonly RunSummary[];
  onOpenRun(id: string): void;
  selectedId?: string;
  label?: string;
}) {
  return (
    <div className="mds-runs-ledger">
      <table className="mds-runs-table" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Workflow</th>
            <th scope="col">Status</th>
            <th scope="col" className="mds-run-started">
              Started
            </th>
            <th scope="col" className="mds-run-duration">
              Duration
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} data-selected={run.id === selectedId || undefined}>
              <td>
                <Button
                  className="mds-text-action"
                  onClick={() => onOpenRun(run.id)}
                  aria-expanded={selectedId === undefined ? undefined : run.id === selectedId}
                >
                  {run.title}
                </Button>
                <small>
                  {run.trigger} · {run.model}
                </small>
                <time className="mds-run-mobile" dateTime={run.dateTime}>
                  {run.started}
                </time>
              </td>
              <td>
                <StatusLabel state={run.state} />
                {run.note && <small>{run.note}</small>}
                <small className="mds-run-mobile">{run.duration}</small>
              </td>
              <td className="mds-run-started">
                <time dateTime={run.dateTime}>{run.started}</time>
              </td>
              <td className="mds-run-duration">{run.duration}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!runs.length && <p className="mds-pattern-empty">No runs yet. Run a workflow to see its history here.</p>}
    </div>
  );
}

export function TranscriptMessage({ speaker, children }: { speaker: "user" | "assistant"; children: ReactNode }) {
  return (
    <div className={`mds-message mds-message--${speaker}`}>
      <span className="mds-message-speaker">{speaker === "user" ? "You" : "Assistant"}</span>
      <div>{children}</div>
    </div>
  );
}

export function ToolActivity({
  summary,
  state = "completed",
  children,
}: {
  summary: string;
  state?: "completed" | "needs-review" | "failed";
  children: ReactNode;
}) {
  return (
    <details className={`mds-tool mds-tool--${state}`}>
      <summary>
        <Eye size={14} aria-hidden="true" />
        <span>{summary}</span>
        <StatusLabel state={state} />
      </summary>
      <div className="mds-tool-detail">{children}</div>
    </details>
  );
}

export function RunPanel({
  title,
  state,
  metadata,
  children,
  outcome,
}: {
  title: string;
  state: RunState;
  metadata: string;
  children: ReactNode;
  outcome: ReactNode;
}) {
  return (
    <article className="mds-run-panel" aria-label={`Run detail: ${title}`}>
      <header>
        <h3>{title}</h3>
        <StatusLabel state={state} />
      </header>
      <p className="mds-run-meta">{metadata}</p>
      <h4>Run log</h4>
      <div className="mds-transcript">{children}</div>
      <footer>{outcome}</footer>
    </article>
  );
}

export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  busy = false,
  attachments = [],
  onRemoveAttachment,
  onAttach,
  model = "",
  modelOptions,
  onModelChange,
}: {
  value: string;
  onChange(value: string): void;
  onSend(): void;
  onStop?(): void;
  busy?: boolean;
  attachments?: readonly string[];
  onRemoveAttachment?(name: string): void;
  onAttach?(): void;
  model?: string;
  modelOptions?: readonly { value: string; label: string }[];
  onModelChange?(value: string): void;
}) {
  const id = useId();
  return (
    <form
      className="mds-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && value.trim()) onSend();
      }}
    >
      <div className="mds-composer-attachments">
        {attachments.map((name) => (
          <span className="mds-attachment" key={name}>
            {name}
            {onRemoveAttachment && (
              <IconButton label={`Remove attachment ${name}`} onClick={() => onRemoveAttachment(name)}>
                <X size={12} />
              </IconButton>
            )}
          </span>
        ))}
        {onAttach && (
          <Button onClick={onAttach}>
            <Plus />
            Attach note
          </Button>
        )}
      </div>
      <label htmlFor={id} className="mds-label">
        Message
      </label>
      <textarea
        id={id}
        className="mds-input"
        rows={3}
        placeholder="Ask about your notes…"
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
      />
      <footer>
        <Badge>Preview</Badge>
        {modelOptions && (
          <label className="mds-composer-model">
            Model{" "}
            <select
              className="mds-input"
              aria-label="Chat model"
              value={model}
              disabled={busy || !onModelChange}
              onChange={(event) => onModelChange?.(event.target.value)}
            >
              {modelOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {busy ? (
          <Button variant="danger" onClick={onStop} disabled={!onStop}>
            <Square />
            Stop
          </Button>
        ) : (
          <Button type="submit" variant="primary" disabled={!value.trim()}>
            Send
          </Button>
        )}
      </footer>
    </form>
  );
}

export function ChangeRow({
  name,
  path,
  actor,
  action,
  time,
  stale,
  children,
}: {
  name: string;
  path: string;
  actor: string;
  action: string;
  time: string;
  stale?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="mds-change-row">
      <FilePenLine size={16} aria-hidden="true" />
      <div className="mds-change-main">
        <strong>{name}</strong>
        <div className="mds-change-meta">
          {actor} · {action} · {time}
        </div>
        <div className="mds-change-path">{path}</div>
        {stale && <span className="mds-change-stale">File changed since proposal</span>}
      </div>
      <div className="mds-change-actions">{children}</div>
    </div>
  );
}

export function DiffView({ lines }: { lines: readonly { type: "context" | "add" | "remove"; text: string }[] }) {
  return (
    <pre className="mds-diff" aria-label="Proposed changes">
      <code>
        {lines.map((line, index) => (
          <span className={`mds-diff-line mds-diff-line--${line.type}`} key={index}>
            <span className="mds-diff-sign">{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</span>
            {line.text}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}
