import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Bot, Paperclip, Plus, Save, TextSelect, X } from "lucide-react";
import { Badge, Button, IconButton, Notice } from "../design-system/components";
import { ChatComposer } from "../design-system/patterns";
import { api } from "../ipc/api";
import { errorMessage, type Agent, type ClaudeInfo } from "../ipc/types";
import { chatAsMarkdown, listenToChat, useChat, type ChatItem } from "../state/chat";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { isSpecialTab } from "./specialTabs";
import { TranscriptItem, openTranscriptLink } from "./Transcript";
import { DesignSystemScope } from "./DesignSystemScope";
import { dayStamp } from "../daily";
import { noteSelection } from "../editor/noteViews";
import { vaultPrefs } from "../state/vaultPreferences";
import "../design-system/patterns.css";
import "./workflowStatus.css";
import "./chatPanel.css";

const noteName = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/i, "");
export function ChatPanel({ id }: { id: string }) {
  const chat = useChat((state) => state.chats[id]);
  const root = useChat((state) => state.root);
  if (!chat)
    return (
      <DesignSystemScope className="chat chat-unavailable" role="group" aria-label="Chat">
        <Notice>This chat is no longer available.</Notice>
        <Button variant="secondary" disabled={!root} onClick={() => useUi.getState().showChat()}>
          New chat
        </Button>
      </DesignSystemScope>
    );
  return <ConversationView key={`${root}:${id}`} id={id} root={root} />;
}
function ConversationView({ id, root }: { id: string; root: string | null }) {
  const chat = useChat((state) => state.chats[id]);
  const { items, run, cost, noMosaic, attached, selection, agent, draft: input, model } = chat;
  const storageError = useChat((state) => state.storageError);
  const update = (patch: Partial<typeof chat>) => {
    if (current()) useChat.getState().update(id, patch);
  };
  const current = () =>
    !!root &&
    useChat.getState().root === root &&
    useVault.getState().vault?.root === root &&
    !!useChat.getState().chats[id];
  const active = useWorkspace(
    (state) => state.panes.map((pane) => pane.active).find((path) => path && !isSpecialTab(path)) ?? null,
  );
  const [claude, setClaude] = useState<ClaudeInfo | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkTick, setCheckTick] = useState(0);
  const [skipped, setSkipped] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [returnRename, setReturnRename] = useState(false);
  const saveOpener = useRef<HTMLElement | null>(null);
  const saveLock = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const message = useRef<HTMLTextAreaElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const pickerOpener = useRef<HTMLElement | null>(null);
  const picker = useUi((state) => state.picker);
  useEffect(() => {
    let live = true;
    listenToChat();
    setCheckError(null);
    setClaude(null);
    void api.chatCheck().then(
      (info) => {
        if (live) setClaude(info);
      },
      (cause) => {
        if (live) setCheckError(errorMessage(cause));
      },
    );
    void api.agents().then(
      (result) => {
        if (live) setAgents(result);
      },
      () => {
        if (live) setAgents([]);
      },
    );
    return () => {
      live = false;
    };
  }, [checkTick]);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [items, run]);
  useEffect(() => {
    if (!picker && pickerOpener.current) {
      pickerOpener.current.focus({ preventScroll: true });
      pickerOpener.current = null;
    }
  }, [picker]);
  useEffect(() => {
    if (!renaming && returnRename) {
      renameButton.current?.focus({ preventScroll: true });
      setReturnRename(false);
    }
  }, [renaming, returnRename]);
  useEffect(() => {
    if (!saving && saveOpener.current) {
      if (saveOpener.current.isConnected) saveOpener.current.focus({ preventScroll: true });
      saveOpener.current = null;
    }
  }, [saving]);
  const candidate = active && !isSpecialTab(active) ? active : (attached[0] ?? null);
  const activeNote = candidate !== skipped ? candidate : null;
  const context = useMemo(
    () => [...new Set([...(activeNote ? [activeNote] : []), ...attached])],
    [activeNote, attached],
  );
  const send = () => {
    if (!current() || run !== null || !claude?.path) return;
    let text = input.trim(),
      chosen = agent;
    const slash = /^\/([\p{L}\p{N}-]+)\s*([\s\S]*)$/u.exec(text);
    if (slash) {
      const found = agents.find((entry) => entry.name === slash[1].toLowerCase());
      if (!found) return setError(`No agent named “${slash[1]}” in ${vaultPrefs().agents_folder}/.`);
      chosen = found.name;
      text = slash[2];
    }
    if (!text && !chosen) return;
    setError(null);
    update({ draft: "", selection: null });
    void useChat.getState().send(id, text || "Go ahead.", context, activeNote, chosen, selection, model || null);
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (run === null) send();
    }
  };
  const attach = (opener: HTMLElement) => {
    if (!current()) return;
    pickerOpener.current = opener;
    const notes = useVault
      .getState()
      .entries.filter(
        (entry) => !entry.is_dir && entry.path.toLowerCase().endsWith(".md") && !context.includes(entry.path),
      );
    useUi.getState().openPicker({
      placeholder: "Attach a note to the chat",
      items: notes.map((note) => ({ id: note.path, label: noteName(note.path), detail: note.path })),
      hint: "↵ attach · esc cancel",
      onPick: (item) => {
        if (current()) update({ attached: [...new Set([...useChat.getState().chats[id].attached, item.id])] });
      },
    });
  };
  const attachSelection = () => {
    if (!activeNote) return setError("Open a note and select some text first.");
    const picked = noteSelection(activeNote);
    if (!picked) return setError("Select some text in the open note first.");
    if (picked.text.length > 20_000)
      return setError("That selection is too large to attach (maximum 20,000 characters).");
    update({ selection: { path: picked.path, text: picked.text } });
    setError(null);
    message.current?.focus();
  };
  const save = async (opener: HTMLElement) => {
    if (!current() || saveLock.current || run !== null || !items.length) return;
    saveLock.current = true;
    saveOpener.current = opener;
    setSaving(true);
    setError(null);
    const first = items.find((item) => item.kind === "user") as Extract<ChatItem, { kind: "user" }> | undefined;
    const words = (first?.text ?? "Chat")
      .replace(/[\\/:*?"<>|#^[\]]/g, "")
      .split(/\s+/)
      .slice(0, 6)
      .join(" ");
    const time = new Date().toTimeString().slice(0, 5).replace(":", "");
    const path = `${vaultPrefs().agents_folder}/Chats/${dayStamp()} ${time} ${words}.md`.replace(/\s+\.md$/, ".md");
    try {
      await api.create(path, `# ${words}\n\n${chatAsMarkdown(items)}\n`, root!);
      if (current()) await useWorkspace.getState().open(path, { newTab: true });
    } catch (cause) {
      if (current()) setError(errorMessage(cause));
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  };
  const rename = async () => {
    if (!current() || renaming) return;
    setRenaming(true);
    try {
      const title = await useUi.getState().askText({ title: "Rename chat", value: chat.title });
      if (current() && title?.trim()) update({ title: title.trim() });
    } finally {
      setRenaming(false);
      if (current()) setReturnRename(true);
    }
  };
  return (
    <DesignSystemScope className="chat chat-panel workflow-status-scope" role="group" aria-label="Chat">
      <header className="chat-panel-heading">
        <div>
          <h1>{chat.title}</h1>
          <p className="mds-hint">Claude Code · {model || "Default model"}</p>
        </div>
        <Button ref={renameButton} disabled={renaming || saving} onClick={() => void rename()}>
          Rename
        </Button>
      </header>
      {storageError && <Notice tone="error">{storageError}</Notice>}
      {checkError ? (
        <Notice tone="error">
          {checkError}
          <Button variant="secondary" onClick={() => setCheckTick((tick) => tick + 1)}>
            Retry connection check
          </Button>
        </Notice>
      ) : !claude ? (
        <Notice>Checking Claude Code…</Notice>
      ) : !claude.path ? (
        <Notice>
          Chat uses Claude Code, which isn't installed. Install it from claude.com/claude-code, run <code>claude</code>{" "}
          once in a terminal to log in, then retry.
          <Button variant="secondary" onClick={() => setCheckTick((tick) => tick + 1)}>
            Retry connection check
          </Button>
        </Notice>
      ) : (
        <>
          <div
            className="chat-list mds-transcript"
            ref={list}
            role="region"
            aria-label="Chat transcript"
            tabIndex={0}
            onClick={(event) => {
              if (current()) openTranscriptLink(event, (cause) => setError(errorMessage(cause)));
            }}
          >
            {!items.length && (
              <div className="chat-empty">
                <Bot size={22} aria-hidden="true" />
                <p>
                  Ask Claude about your notes, or to change them. Changes appear in AI activity, with Undo; in folders
                  you review, they wait for you.
                </p>
                {!!agents.length && (
                  <div className="chat-starters">
                    {agents.map((entry) => (
                      <Button
                        variant="secondary"
                        key={entry.name}
                        title={entry.description}
                        onClick={() => {
                          update({ agent: entry.name });
                          message.current?.focus();
                        }}
                      >
                        {entry.title}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {items.map((item, index) => (
              <TranscriptItem key={index} item={item} />
            ))}
            {run !== null && (
              <p className="mds-hint" role="status">
                Working…
              </p>
            )}
          </div>
          {noMosaic && (
            <Notice tone="warning">
              Mosaic's tools weren't connected for that answer: Claude could read files but not change them through
              Mosaic.
            </Notice>
          )}
          {error && <Notice tone="error">{error}</Notice>}
          <ChatComposer
            value={input}
            onChange={(draft) => update({ draft })}
            onSend={send}
            onStop={() => {
              if (current()) useChat.getState().stop(id);
            }}
            busy={run !== null}
            canSend={!!input.trim() || !!agent}
            messageLabel="Message to Claude"
            textareaProps={{
              ref: message,
              disabled: false,
              onKeyDown: onKey,
              placeholder: agent
                ? "Anything to add for this agent? (↵ to run)"
                : agents.length
                  ? "Ask Claude… (↵ to send, /agent to run one)"
                  : "Ask Claude… (↵ to send)",
            }}
            model={model}
            onModelChange={(value) => update({ model: value })}
            modelOptions={[
              { value: "", label: "Default model" },
              { value: "sonnet", label: "Sonnet" },
              { value: "opus", label: "Opus" },
              { value: "haiku", label: "Haiku" },
            ]}
            sendVariant="secondary"
            stopVariant="secondary"
            annotation={cost > 0 ? <Badge title="What this chat has cost so far">${cost.toFixed(2)}</Badge> : null}
            footerStart={
              <>
                <IconButton
                  label="New chat"
                  disabled={!items.length || saving}
                  onClick={() => useUi.getState().showChat()}
                >
                  <Plus aria-hidden="true" />
                </IconButton>
                <IconButton
                  label="Save as note"
                  disabled={!items.length || run !== null || saving}
                  onClick={(event) => void save(event.currentTarget)}
                >
                  <Save aria-hidden="true" />
                </IconButton>
              </>
            }
            attachmentContent={
              <>
                {agent && (
                  <span className="mds-attachment" title={agents.find((entry) => entry.name === agent)?.description}>
                    <Bot size={14} aria-hidden="true" />
                    {agents.find((entry) => entry.name === agent)?.title ?? agent}
                    <IconButton
                      label="Don't use this agent"
                      onClick={() => {
                        update({ agent: null });
                        message.current?.focus();
                      }}
                    >
                      <X />
                    </IconButton>
                  </span>
                )}
                {context.map((path) => (
                  <span className="mds-attachment" key={path} title={path}>
                    {noteName(path)}
                    <IconButton
                      label={`Detach ${noteName(path)}`}
                      onClick={() => {
                        if (path === activeNote) setSkipped(path);
                        update({ attached: attached.filter((entry) => entry !== path) });
                        message.current?.focus();
                      }}
                    >
                      <X />
                    </IconButton>
                  </span>
                ))}
                {selection && (
                  <span className="mds-attachment" title={selection.text}>
                    <TextSelect size={14} aria-hidden="true" />
                    Selection from {noteName(selection.path)}
                    <IconButton
                      label="Detach selected text"
                      onClick={() => {
                        update({ selection: null });
                        message.current?.focus();
                      }}
                    >
                      <X />
                    </IconButton>
                  </span>
                )}
                <IconButton label="Attach selected text from the open note" onClick={attachSelection}>
                  <TextSelect aria-hidden="true" />
                </IconButton>
                <IconButton label="Attach a note" onClick={(event) => attach(event.currentTarget)}>
                  <Paperclip aria-hidden="true" />
                </IconButton>
              </>
            }
          />
        </>
      )}
    </DesignSystemScope>
  );
}
