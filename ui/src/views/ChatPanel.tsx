// The chat with Claude, in the right panel. Claude Code runs headless in the vault (src-tauri/src/chat.rs)
// and changes notes only through Mosaic's tools, so every change is in AI activity with Undo, and in
// reviewed folders becomes a proposal. The open note is attached as context; agents from Agents/
// start a message (pick one, or type /name).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Bot, Eye, Paperclip, Pencil, Plus, Save, Square, X } from "lucide-react";
import { api } from "../ipc/api";
import { errorMessage, type Agent, type ClaudeInfo } from "../ipc/types";
import { renderMarkdown } from "../markdown";
import { resolveLink } from "../links";
import { chatAsMarkdown, listenToChat, useChat, type ChatItem } from "../state/chat";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { isSpecialTab } from "./specialTabs";
import { dayStamp } from "../daily";

const noteName = (p: string) => (p.split("/").pop() ?? p).replace(/\.md$/i, "");

export function ChatPanel() {
  const items = useChat((s) => s.items);
  const run = useChat((s) => s.run);
  const cost = useChat((s) => s.cost);
  const noMosaic = useChat((s) => s.noMosaic);
  const active = useWorkspace((s) => s.panes.find((p) => p.id === s.focused)?.active ?? null);
  const [claude, setClaude] = useState<ClaudeInfo | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agent, setAgent] = useState<string | null>(null);
  const [attached, setAttached] = useState<string[]>([]);
  // The open note is attached unless removed (for that note).
  const [skipped, setSkipped] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listenToChat();
    api.chatCheck().then(setClaude, () => setClaude({ path: null, version: null }));
    api.agents().then(setAgents, () => setAgents([]));
  }, []);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [items, run]);

  const activeNote = active && !isSpecialTab(active) && active !== skipped ? active : null;
  const context = useMemo(() => [...new Set([...(activeNote ? [activeNote] : []), ...attached])], [activeNote, attached]);

  const send = () => {
    let text = input.trim();
    let use = agent;
    // "/name rest" runs an agent.
    const slash = /^\/([\p{L}\p{N}-]+)\s*([\s\S]*)$/u.exec(text);
    if (slash) {
      const found = agents.find((a) => a.name === slash[1].toLowerCase());
      if (!found) return setError(`No agent named “${slash[1]}” in Agents/.`);
      use = found.name;
      text = slash[2];
    }
    if (!text && !use) return;
    setError(null);
    setInput("");
    void useChat.getState().send(text || "Go ahead.", context, activeNote, use);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (run === null) send();
    }
  };
  const attach = () => {
    const notes = useVault.getState().entries.filter((e) => !e.is_dir && e.path.toLowerCase().endsWith(".md") && !context.includes(e.path));
    useUi.getState().openPicker({
      placeholder: "Attach a note to the chat",
      items: notes.map((n) => ({ id: n.path, label: noteName(n.path), detail: n.path })),
      hint: "↵ attach · esc cancel",
      onPick: (it) => setAttached((a) => [...a, it.id]),
    });
  };
  const save = async () => {
    const first = items.find((i) => i.kind === "user") as Extract<ChatItem, { kind: "user" }> | undefined;
    const words = (first?.text ?? "Chat").replace(/[\\/:*?"<>|#^[\]]/g, "").split(/\s+/).slice(0, 6).join(" ");
    const time = new Date().toTimeString().slice(0, 5).replace(":", "");
    const path = `Agents/Chats/${dayStamp()} ${time} ${words}.md`.replace(/\s+\.md$/, ".md");
    try {
      await api.create(path, `# ${words}\n\n${chatAsMarkdown(items)}\n`);
      void useWorkspace.getState().open(path, { newTab: true });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (claude && !claude.path) {
    return (
      <div className="chat">
        <div className="chat-empty">
          <Bot size={22} />
          <p>
            The chat uses <strong>Claude Code</strong>, which isn't installed. Install it from claude.com/claude-code, run <code>claude</code> once in a terminal to log in,
            then reopen this panel.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat">
      <div className="chat-list" ref={list} onClick={(e) => openLink(e)}>
        {items.length === 0 && (
          <div className="chat-empty">
            <Bot size={22} />
            <p>Ask Claude about your notes, or to change them. Changes appear in AI activity, with Undo; in folders you review, they wait for you.</p>
            {agents.length > 0 && (
              <div className="chat-starters">
                {agents.map((a) => (
                  <button key={a.name} title={a.description} onClick={() => setAgent(a.name)}>
                    {a.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {items.map((it, i) => (
          <Item key={i} item={it} />
        ))}
        {run !== null && <div className="chat-thinking">Working…</div>}
      </div>
      {noMosaic && <p className="chat-warn">Mosaic's tools weren't connected for that answer: Claude could read files but not change them through Mosaic.</p>}
      {error && <p className="error-text chat-warn">{error}</p>}
      <div className="chat-compose">
        <div className="chat-chips">
          {agent && (
            <span className="chat-chip agent" title={agents.find((a) => a.name === agent)?.description}>
              <Bot size={11} /> {agents.find((a) => a.name === agent)?.title ?? agent}
              <button aria-label="Don't use this agent" onClick={() => setAgent(null)}>
                <X size={10} />
              </button>
            </span>
          )}
          {context.map((p) => (
            <span key={p} className="chat-chip" title={p}>
              {noteName(p)}
              <button aria-label={`Detach ${noteName(p)}`} onClick={() => (p === activeNote ? setSkipped(p) : setAttached((a) => a.filter((x) => x !== p)))}>
                <X size={10} />
              </button>
            </span>
          ))}
          <button className="chat-chip add" title="Attach a note" onClick={attach}>
            <Paperclip size={11} />
          </button>
        </div>
        <textarea
          value={input}
          rows={3}
          placeholder={agent ? "Anything to add for this agent? (↵ to run)" : agents.length ? "Ask Claude… (↵ to send, /agent to run one)" : "Ask Claude… (↵ to send)"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="chat-actions">
          <button title="New chat" aria-label="New chat" onClick={() => useChat.getState().clear()} disabled={!items.length}>
            <Plus size={14} />
          </button>
          <button title="Save this chat as a note in Agents/Chats" aria-label="Save as note" onClick={() => void save()} disabled={!items.length || run !== null}>
            <Save size={14} />
          </button>
          {cost > 0 && <span className="chat-cost" title="What this chat has cost so far">${cost.toFixed(2)}</span>}
          <span className="spacer" />
          {run !== null ? (
            <button className="danger" onClick={() => useChat.getState().stop()}>
              <Square size={12} /> Stop
            </button>
          ) : (
            <button className="primary" onClick={send} disabled={!input.trim() && !agent}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="chat-msg user">
          {item.agent && <div className="chat-agent"><Bot size={11} /> {item.agent}</div>}
          {item.text}
        </div>
      );
    case "text": {
      const { entries, aliases } = useVault.getState();
      const html = renderMarkdown(item.text, (t) => resolveLink(t, entries, null, aliases));
      return <div className="chat-msg assistant md-render" dangerouslySetInnerHTML={{ __html: html }} />;
    }
    case "tool":
      return (
        <div className={`chat-tool ${item.error ? "failed" : ""}`}>
          {item.writes ? <Pencil size={11} /> : <Eye size={11} />}
          {item.path ? (
            <button className="chat-tool-link" data-path={item.path}>
              {item.summary}
            </button>
          ) : (
            <span>{item.summary}</span>
          )}
          {item.review !== null && (
            <button className="chat-review" onClick={() => useUi.getState().setSidebarTab("activity")} title="Waiting for your review in AI activity">
              proposed — review
            </button>
          )}
          {item.error && <span className="chat-tool-error" title={item.error}>failed</span>}
        </div>
      );
    case "error":
      return <div className="chat-msg error">{item.text}</div>;
  }
}

/** Clicks on [[links]] in answers and on tool lines open the note. */
function openLink(e: MouseEvent) {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-target], [data-path]");
  if (!el) return;
  const { entries, aliases } = useVault.getState();
  const path = el.dataset.path ?? resolveLink(el.dataset.target ?? "", entries, null, aliases);
  if (path && entries.some((x) => x.path === path)) void useWorkspace.getState().open(path, { newTab: true });
}
