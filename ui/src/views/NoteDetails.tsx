import { useEffect, useMemo, useRef, useState } from "react";
import { GripVertical, Plus } from "lucide-react";
import { api } from "../ipc/api";
import { errorMessage, type Backlink, type Mention } from "../ipc/types";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { parse as parseHeadings } from "./outline";
import {
  addSiblingNoteSection,
  dropNoteSection,
  moveNoteSection,
  noteCursorPosition,
  revealNotePosition,
} from "../editor/noteViews";
import { PropertiesEditor } from "../editor/PropertiesEditor";
import { FRONTMATTER_RE } from "../editor/livePreview";
import { noteAttachments } from "../attachments";
import { saveVaultPreferences, useVaultPreferences } from "../state/vaultPreferences";
import { Badge, Button, IconButton, Notice } from "../design-system/components";
import { DesignSystemScope } from "./DesignSystemScope";
import "./noteDetails.css";

export function NoteDetails({ path }: { path: string }) {
  const content = useWorkspace((s) => s.buffers[path]?.content);
  const root = useVault((s) => s.vault?.root),
    revision = useVault((s) => s.revision);
  const entries = useVault((s) => s.entries),
    aliases = useVault((s) => s.aliases);
  const showAttachments = useVaultPreferences((s) => s.value.show_attachments_in_tree);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [loading, setLoading] = useState(true),
    [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false),
    [problem, setProblem] = useState<string | null>(null);
  const [dragLine, setDragLine] = useState<number | null>(null),
    [dropLine, setDropLine] = useState<number | null>(null);
  const mounted = useRef(true),
    lock = useRef(false),
    retryFocus = useRef(false);
  const backlinkHeading = useRef<HTMLHeadingElement>(null),
    retry = useRef<HTMLButtonElement>(null);
  const outline = useRef<HTMLDivElement>(null);
  const [outlineFocus, setOutlineFocus] = useState<number | null>(null);
  const focusMovedHeading = () => setOutlineFocus(noteCursorPosition(path));
  useEffect(() => {
    if (outlineFocus === null) return;
    const timer = setTimeout(() => {
      outline.current?.querySelector<HTMLElement>(`[data-heading-offset="${outlineFocus}"]`)?.focus();
      setOutlineFocus(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [content, outlineFocus]);
  const current = () => mounted.current && useVault.getState().vault?.root === root;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setLoadProblem(null);
    const timer = setTimeout(() => {
      void api
        .backlinks(path)
        .then(
          (value) => {
            if (live) setBacklinks(value);
          },
          (cause) => {
            if (live) {
              setBacklinks([]);
              setLoadProblem(errorMessage(cause));
            }
          },
        )
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [path, root, revision, tick]);
  useEffect(() => {
    if (!loading && retryFocus.current) {
      (loadProblem ? retry.current : backlinkHeading.current)?.focus({ preventScroll: true });
      retryFocus.current = false;
    }
  }, [loading, loadProblem]);
  const act = async (work: () => Promise<unknown>) => {
    if (!current() || lock.current) return;
    lock.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (cause) {
      if (current()) setProblem(errorMessage(cause));
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  const open = (target: string, newTab: boolean) => void act(() => useWorkspace.getState().open(target, { newTab }));
  const headings = useMemo(() => (path.endsWith(".md") && content ? parseHeadings(content) : []), [path, content]);
  const attachments = useMemo(
    () => (path.endsWith(".md") && typeof content === "string" ? noteAttachments(content, path, entries, aliases) : []),
    [path, content, entries, aliases],
  );
  const grouped = useMemo(() => {
    const result = new Map<string, Backlink[]>();
    for (const link of backlinks) {
      const list = result.get(link.source) ?? [];
      if (!list.some((item) => item.line === link.line && item.context === link.context)) list.push(link);
      result.set(link.source, list);
    }
    return [...result];
  }, [backlinks]);
  return (
    <DesignSystemScope className="links-panel note-details" role="group" aria-label="Note details" aria-busy={busy}>
      {problem && (
        <Notice tone="error">
          {problem}
          <Button onClick={() => setProblem(null)}>Dismiss</Button>
        </Notice>
      )}
      {path.endsWith(".md") && content !== null && content !== undefined && (
        <section aria-label="Properties">
          <h3>Properties</h3>
          <PropertiesEditor
            inheritScope
            key={content.match(FRONTMATTER_RE)?.[1] ?? ""}
            yaml={content.match(FRONTMATTER_RE)?.[1] ?? ""}
            onChange={(yaml) => {
              const fm = FRONTMATTER_RE.exec(content);
              const next = `---\n${yaml.trimEnd()}\n---`;
              useWorkspace
                .getState()
                .replaceContent(path, fm ? next + content.slice(fm[0].length) : `${next}\n\n${content}`);
            }}
            onEditSource={() => revealNotePosition(path, 1)}
          />
        </section>
      )}
      {path.endsWith(".md") && (
        <section aria-label="Attachments">
          <h3>
            Attachments <Badge>{attachments.length}</Badge>
          </h3>
          {!attachments.length ? (
            <p className="mds-hint">No local files are embedded in this note.</p>
          ) : (
            attachments.map((target) => (
              <Button
                className="detail-link"
                key={target}
                title={target}
                disabled={busy}
                onClick={(event) => open(target, event.metaKey)}
              >
                {target}
              </Button>
            ))
          )}
          {!showAttachments && !!attachments.length && (
            <Button
              variant="secondary"
              className="show-attachments"
              disabled={busy}
              onClick={() => void act(() => saveVaultPreferences({ show_attachments_in_tree: true }))}
            >
              Show attachments in file tree
            </Button>
          )}
        </section>
      )}
      <section aria-label="Backlinks" aria-busy={loading}>
        <h3 ref={backlinkHeading} tabIndex={-1}>
          Backlinks <Badge>{backlinks.length}</Badge>
        </h3>
        {loading ? (
          <p className="mds-hint" role="status">
            Loading backlinks…
          </p>
        ) : loadProblem ? (
          <Notice tone="error">
            {loadProblem}
            <Button
              ref={retry}
              variant="secondary"
              onClick={() => {
                retryFocus.current = true;
                setTick((value) => value + 1);
              }}
            >
              Retry backlinks
            </Button>
          </Notice>
        ) : !grouped.length ? (
          <p className="mds-hint">No other notes link here yet.</p>
        ) : (
          grouped.map(([source, links]) => (
            <div className="backlink" key={source}>
              <Button
                className="detail-link backlink-source"
                disabled={busy}
                onClick={(event) => open(source, event.metaKey)}
              >
                {source.replace(/\.md$/, "")}
              </Button>
              {links.map((link, index) =>
                link.context ? (
                  <p className="backlink-context" key={index} title={link.line ? `Line ${link.line}` : undefined}>
                    {link.context}
                  </p>
                ) : null,
              )}
            </div>
          ))
        )}
      </section>
      {path.endsWith(".md") && <UnlinkedMentions path={path} root={root} revision={revision} />}
      {!!headings.length && (
        <section aria-label="Outline">
          <h3>Outline</h3>
          <p className="mds-hint">Drag sibling sections to reorder. Use ⌥↑/⌥↓ from the keyboard.</p>
          <div ref={outline} className="outline">
            {headings.map((heading) => (
              <div
                key={`${heading.line}:${heading.text}`}
                className={`outline-row${dragLine === heading.line ? " dragging" : ""}${dropLine === heading.line ? " drop" : ""}`}
                style={{ paddingLeft: (heading.level - 1) * 12 }}
                onDragOver={(event) => {
                  if (dragLine !== null && dragLine !== heading.line) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDropLine(heading.line);
                  }
                }}
                onDragLeave={() => dropLine === heading.line && setDropLine(null)}
                onDrop={(event) => {
                  if (!event.dataTransfer.types.includes("application/x-mosaic-section")) return;
                  event.preventDefault();
                  const from = Number(event.dataTransfer.getData("application/x-mosaic-section"));
                  const bounds = event.currentTarget.getBoundingClientRect();
                  if (
                    Number.isInteger(from) &&
                    dropNoteSection(
                      path,
                      from,
                      heading.line,
                      event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
                    )
                  )
                    focusMovedHeading();
                  setDragLine(null);
                  setDropLine(null);
                }}
              >
                <Button
                  className="outline-item"
                  data-heading-offset={heading.offset}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  draggable
                  disabled={busy}
                  aria-label={`${heading.text}. Drag to reorder; Option Up or Option Down moves among sibling sections.`}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("application/x-mosaic-section", String(heading.line));
                    setDragLine(heading.line);
                  }}
                  onDragEnd={() => {
                    setDragLine(null);
                    setDropLine(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
                      event.preventDefault();
                      if (moveNoteSection(path, heading.line, event.key === "ArrowUp" ? -1 : 1)) focusMovedHeading();
                    }
                  }}
                  onClick={() => revealNotePosition(path, heading.offset)}
                >
                  <GripVertical aria-hidden="true" />
                  <span>{heading.text}</span>
                </Button>
                <IconButton
                  className="outline-add"
                  label={`Add a section after ${heading.text}`}
                  title={`Add a level ${heading.level} section after “${heading.text}”`}
                  disabled={busy}
                  onClick={() => addSiblingNoteSection(path, heading.line)}
                >
                  <Plus aria-hidden="true" />
                </IconButton>
              </div>
            ))}
          </div>
        </section>
      )}
    </DesignSystemScope>
  );
}

function UnlinkedMentions({ path, root, revision }: { path: string; root: string | undefined; revision: number }) {
  const [open, setOpen] = useState(false),
    [mentions, setMentions] = useState<Mention[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0);
  const mounted = useRef(true),
    lock = useRef(false),
    toggle = useRef<HTMLButtonElement>(null);
  const current = () => mounted.current && useVault.getState().vault?.root === root;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setProblem(null);
    setMentions(null);
    api
      .unlinkedMentions(path)
      .then(
        (value) => {
          if (live) setMentions(value);
        },
        (cause) => {
          if (live) setProblem(errorMessage(cause));
        },
      )
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [open, path, root, revision, tick]);
  const link = async (mention: Mention) => {
    if (!current() || lock.current) return;
    const previousFocus = document.activeElement;
    lock.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await api.linkMention(mention.source, mention.line, mention.text, path);
      if (current()) {
        setMentions(
          (list) => list?.filter((item) => !(item.source === mention.source && item.line === mention.line)) ?? null,
        );
        requestAnimationFrame(() => {
          if (document.activeElement === document.body || document.activeElement === previousFocus)
            toggle.current?.focus();
        });
      }
    } catch (cause) {
      if (current()) setProblem(errorMessage(cause));
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  return (
    <section aria-label="Unlinked mentions" aria-busy={loading || busy}>
      <h3>
        <Button ref={toggle} className="section-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? "▾" : "▸"} Unlinked mentions {mentions && open && <Badge>{mentions.length}</Badge>}
        </Button>
      </h3>
      {open && loading && (
        <p className="mds-hint" role="status">
          Loading mentions…
        </p>
      )}
      {open && !loading && mentions?.length === 0 && (
        <p className="mds-hint">No other notes mention this one without a link.</p>
      )}
      {open &&
        !loading &&
        mentions?.map((mention) => (
          <div key={`${mention.source}:${mention.line}`} className="backlink mention">
            <Button
              className="detail-link backlink-source"
              disabled={busy}
              onClick={(event) =>
                void useWorkspace
                  .getState()
                  .open(mention.source, { newTab: event.metaKey })
                  .catch((cause) => current() && setProblem(errorMessage(cause)))
              }
            >
              {mention.source.replace(/\.md$/, "")}
            </Button>
            <p className="backlink-context">{mention.context}</p>
            <Button
              variant="secondary"
              disabled={busy}
              title={`Turn “${mention.text}” into a link to this note`}
              onClick={() => void link(mention)}
            >
              Link
            </Button>
          </div>
        ))}
      {open && problem && (
        <Notice tone="error">
          {problem}
          <Button
            variant="secondary"
            disabled={loading || busy}
            onClick={() => {
              toggle.current?.focus();
              setTick((value) => value + 1);
            }}
          >
            Retry mentions
          </Button>
        </Notice>
      )}
    </section>
  );
}
