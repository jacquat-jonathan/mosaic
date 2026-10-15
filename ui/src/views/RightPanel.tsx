import { useEffect, useMemo, useState } from "react";
import { GripVertical, Plus } from "lucide-react";
import { isSpecialTab, contextKind, parseView } from "./specialTabs";
import { api } from "../ipc/api";
import { errorMessage, type Backlink, type Mention } from "../ipc/types";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { parse as parseMarkdownHeadings } from "./outline";
import { useUi } from "../state/ui";
import { useChat } from "../state/chat";
import { usePlanning } from "../state/planning";
import { RunDetail, WorkflowContext } from "./Workflows";
import { addSiblingNoteSection, dropNoteSection, moveNoteSection, revealNotePosition } from "../editor/noteViews";
import { PropertiesEditor } from "../editor/PropertiesEditor";
import { FRONTMATTER_RE } from "../editor/livePreview";
import { dayStamp } from "../daily";
import { openDailyNote } from "../actions";
import type { Days } from "../ipc/types";
import { TaskList } from "./CalendarView";
import { noteAttachments } from "../attachments";
import { saveVaultPreferences, useVaultPreferences } from "../state/vaultPreferences";

/** Context follows the focused workspace, independently of the selected destination. */
export function RightPanel() {
  const active = useWorkspace((s) => s.panes.find((p) => p.id === s.focused)?.active ?? null);
  const kind = contextKind(active);
  if (!active || !kind) return null;
  const id = parseView(active).id;
  return (
    <aside className="right-panel" aria-label="Workspace context" data-focus-region tabIndex={-1}>
      <header className="context-head">
        <strong>{kind === "note" ? "Note details" : `${kind[0].toUpperCase()}${kind.slice(1)} details`}</strong>
        <button aria-label="Close context panel" onClick={() => useUi.getState().toggleRightPanel()}>
          ×
        </button>
      </header>
      {kind === "note" ? (
        <LinksPanel key={active} />
      ) : kind === "chat" ? (
        <ChatContext id={id} />
      ) : kind === "workflow" ? (
        <WorkflowContext name={id} />
      ) : kind === "run" ? (
        <RunDetail id={id} compact />
      ) : (
        <CalendarContext />
      )}
    </aside>
  );
}
function ChatContext({ id }: { id: string }) {
  const chat = useChat((s) => s.chats[id]);
  if (!chat) return <p className="panel-meta">Chat unavailable.</p>;
  const last = [...chat.items].reverse().find((i) => i.kind === "user");
  return (
    <div className="context-content">
      <h3>Attachments</h3>
      {chat.attached.length ? (
        chat.attached.map((p) => (
          <button key={p} onClick={() => void useWorkspace.getState().open(p, { newTab: true })}>
            {p}
          </button>
        ))
      ) : (
        <p>No attached files.</p>
      )}
      {(chat.selection || last?.selection) && (
        <>
          <h3>Selection</h3>
          <blockquote>{(chat.selection || last?.selection)?.text}</blockquote>
        </>
      )}
      <dl>
        <dt>Provider</dt>
        <dd>Claude Code</dd>
        <dt>Model</dt>
        <dd>{chat.model || "Default"}</dd>
        <dt>Session</dt>
        <dd>{chat.session || "Not started"}</dd>
        <dt>Cost</dt>
        <dd>${chat.cost.toFixed(2)}</dd>
        <dt>Status</dt>
        <dd>{chat.run !== null ? "Running" : chat.noMosaic ? "Tools disconnected" : "Ready"}</dd>
      </dl>
      {last && (
        <>
          <h3>Last message context</h3>
          {last.context.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </>
      )}
    </div>
  );
}
function CalendarContext() {
  const day = usePlanning((s) => s.selectedDay);
  const revision = useVault((s) => s.revision);
  const [data, setData] = useState<Days | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    void api.days(day, day, dayStamp()).then(
      (d) => live && setData(d),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [day, revision, tick]);
  return (
    <div className="context-content">
      <h3>{day}</h3>
      <button onClick={() => void openDailyNote(new Date(`${day}T12:00`), { newTab: true })}>Open daily note</button>
      {error && <p className="error-text">{error}</p>}
      {data && (
        <>
          <p>{data.days[0]?.tasks.filter((t) => t.status === "open").length ?? 0} open tasks</p>
          <h3>Overdue</h3>
          <TaskList
            tasks={data.overdue}
            showNote
            onTick={(t, done) =>
              void api.setTask(t.path, t.line, t.text, done).then(
                () => setTick((n) => n + 1),
                (e) => setError(errorMessage(e)),
              )
            }
          />
        </>
      )}
    </div>
  );
}

/** Backlinks and outline of the active note. */
function LinksPanel() {
  const active = useWorkspace((s) => s.panes.find((p) => p.id === s.focused)?.active ?? null);
  const content = useWorkspace((s) => (active ? s.buffers[active]?.content : null));
  const revision = useVault((s) => s.revision);
  const entries = useVault((s) => s.entries);
  const aliases = useVault((s) => s.aliases);
  const showAttachments = useVaultPreferences((s) => s.value.show_attachments_in_tree);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [dragLine, setDragLine] = useState<number | null>(null);
  const [dropLine, setDropLine] = useState<number | null>(null);

  useEffect(() => {
    if (!active || isSpecialTab(active)) {
      setBacklinks([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api.backlinks(active).then(
        (b) => live && setBacklinks(b),
        () => live && setBacklinks([]),
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [active, revision]);

  const headings = useMemo(
    () => (active?.endsWith(".md") && content ? parseMarkdownHeadings(content) : []),
    [active, content],
  );
  const attachments = useMemo(
    () =>
      active?.endsWith(".md") && typeof content === "string" ? noteAttachments(content, active, entries, aliases) : [],
    [active, content, entries, aliases],
  );
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

  if (!active)
    return (
      <div className="links-panel">
        <div className="panel-meta">No file open.</div>
      </div>
    );
  if (isSpecialTab(active))
    return (
      <div className="links-panel">
        <div className="panel-meta">Backlinks and the outline show for notes.</div>
      </div>
    );
  return (
    <div className="links-panel">
      {active.endsWith(".md") && content !== null && content !== undefined && (
        <section>
          <h3>Properties</h3>
          <PropertiesEditor
            key={content.match(FRONTMATTER_RE)?.[1] ?? ""}
            yaml={content.match(FRONTMATTER_RE)?.[1] ?? ""}
            onChange={(yaml) => {
              const fm = FRONTMATTER_RE.exec(content);
              const next = `---\n${yaml.trimEnd()}\n---`;
              useWorkspace
                .getState()
                .replaceContent(active, fm ? next + content.slice(fm[0].length) : `${next}\n\n${content}`);
            }}
            onEditSource={() => revealNotePosition(active, 1)}
          />
        </section>
      )}
      {active.endsWith(".md") && (
        <section>
          <h3>
            Attachments <span className="count">{attachments.length}</span>
          </h3>
          {attachments.length === 0 ? (
            <p className="panel-meta">No local files are embedded in this note.</p>
          ) : (
            attachments.map((path) => (
              <button
                className="attachment-link"
                key={path}
                title={path}
                onClick={(event) => void useWorkspace.getState().open(path, { newTab: event.metaKey })}
              >
                {path}
              </button>
            ))
          )}
          {!showAttachments && attachments.length > 0 && (
            <button
              className="panel-secondary"
              onClick={() =>
                void saveVaultPreferences({ show_attachments_in_tree: true }).catch((error) =>
                  useVault.getState().setError(errorMessage(error)),
                )
              }
            >
              Show attachments in file tree
            </button>
          )}
        </section>
      )}
      <section>
        <h3>
          Backlinks <span className="count">{backlinks.length}</span>
        </h3>
        {grouped.length === 0 && <p className="panel-meta">No other notes link here yet.</p>}
        {grouped.map(([source, links]) => (
          <div key={source} className="backlink">
            <button
              className="backlink-source"
              onClick={(e) => void useWorkspace.getState().open(source, { newTab: e.metaKey })}
            >
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
          <p className="outline-hint">Drag sibling sections to reorder. Use ⌥↑/⌥↓ from the keyboard.</p>
          <div className="outline">
            {headings.map((h) => {
              return (
                <div
                  key={`${h.line}:${h.text}`}
                  className={`outline-row${dragLine === h.line ? " dragging" : ""}${dropLine === h.line ? " drop" : ""}`}
                  style={{ paddingLeft: (h.level - 1) * 12 }}
                  onDragOver={(event) => {
                    if (dragLine !== null && dragLine !== h.line) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropLine(h.line);
                    }
                  }}
                  onDragLeave={() => dropLine === h.line && setDropLine(null)}
                  onDrop={(event) => {
                    event.preventDefault();
                    const from = Number(event.dataTransfer.getData("application/x-mosaic-section"));
                    const rect = event.currentTarget.getBoundingClientRect();
                    const place = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
                    if (Number.isFinite(from)) dropNoteSection(active, from, h.line, place);
                    setDragLine(null);
                    setDropLine(null);
                  }}
                >
                  <button
                    className="outline-item"
                    draggable
                    aria-label={`${h.text}. Drag to reorder; Option Up or Option Down moves among sibling sections.`}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("application/x-mosaic-section", String(h.line));
                      setDragLine(h.line);
                    }}
                    onDragEnd={() => {
                      setDragLine(null);
                      setDropLine(null);
                    }}
                    onKeyDown={(event) => {
                      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                      event.preventDefault();
                      moveNoteSection(active, h.line, event.key === "ArrowUp" ? -1 : 1);
                    }}
                    onClick={() => revealNotePosition(active, h.offset)}
                  >
                    <GripVertical size={13} aria-hidden="true" />
                    <span>{h.text}</span>
                  </button>
                  <button
                    className="outline-add"
                    aria-label={`Add a section after ${h.text}`}
                    title={`Add a level ${h.level} section after “${h.text}”`}
                    onClick={() => addSiblingNoteSection(active, h.line)}
                  >
                    <Plus size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
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
          {open ? "▾" : "▸"} Unlinked mentions{" "}
          {mentions && open ? <span className="count">{mentions.length}</span> : null}
        </button>
      </h3>
      {open && mentions?.length === 0 && <p className="panel-meta">No other notes mention this one without a link.</p>}
      {open &&
        mentions?.map((m) => (
          <div key={`${m.source}:${m.line}`} className="backlink mention">
            <button
              className="backlink-source"
              onClick={(e) => void useWorkspace.getState().open(m.source, { newTab: e.metaKey })}
            >
              {m.source.replace(/\.md$/, "")}
            </button>
            <div className="backlink-context">{m.context}</div>
            <button
              className="mention-link"
              title={`Turn “${m.text}” into a link to this note`}
              onClick={() => void link(m)}
            >
              Link
            </button>
          </div>
        ))}
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
