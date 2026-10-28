import { useEffect, useRef, useState, type RefObject } from "react";
import { MoreHorizontal } from "lucide-react";
import { Badge, Button, IconButton, Notice } from "../design-system/components";
import { errorMessage } from "../ipc/types";
import { useChat, chatGroup } from "../state/chat";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { DesignSystemScope } from "./DesignSystemScope";
import { viewPath } from "./specialTabs";
import "./chatHistory.css";

export function ChatHistoryPage() {
  const root = useChat((state) => state.root);
  const firstAction = useRef<HTMLButtonElement>(null);
  return (
    <DesignSystemScope className="workspace-page chats-page" role="group" aria-label="Chats list">
      <header className="chats-heading">
        <div>
          <h1>Chats</h1>
          <p className="mds-hint">Your saved conversations, newest first.</p>
        </div>
        <Button ref={firstAction} variant="secondary" disabled={!root} onClick={() => useUi.getState().showChat()}>
          New chat
        </Button>
      </header>
      <ChatRows key={root} fallback={firstAction} />
    </DesignSystemScope>
  );
}
export function ChatList({
  fallback,
  inheritScope = false,
}: {
  fallback?: RefObject<HTMLButtonElement | null>;
  inheritScope?: boolean;
}) {
  const root = useChat((state) => state.root);
  if (inheritScope)
    return (
      <div className="chat-history-list" role="group" aria-label="Saved chats">
        <ChatRows key={root} fallback={fallback} />
      </div>
    );
  return (
    <DesignSystemScope className="chat-history-list" role="group" aria-label="Saved chats">
      <ChatRows key={root} fallback={fallback} />
    </DesignSystemScope>
  );
}
function ChatRows({ fallback }: { fallback?: RefObject<HTMLButtonElement | null> }) {
  const root = useChat((state) => state.root);
  const chats = useChat((state) => state.chats);
  const storageError = useChat((state) => state.storageError);
  const active = useWorkspace((state) => state.panes.find((pane) => pane.id === state.focused)?.active);
  const menu = useUi((state) => state.menu);
  const prompt = useUi((state) => state.prompt);
  const confirm = useUi((state) => state.confirm);
  const scope = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = () => !!root && useChat.getState().root === root && useVault.getState().vault?.root === root;
  useEffect(() => {
    if (!menu && !prompt && !confirm && !busy && opener.current) {
      const target = opener.current.isConnected
        ? opener.current
        : (scope.current?.querySelector<HTMLButtonElement>("[data-chat-open]") ?? fallback?.current);
      target?.focus({ preventScroll: true });
      opener.current = null;
    }
  }, [menu, prompt, confirm, busy, fallback]);
  const act = async (id: string, work: () => Promise<void>) => {
    if (lock.current || !current() || !useChat.getState().chats[id]) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      if (current()) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="chat-history-rows" ref={scope}>
      {(storageError || error) && <Notice tone="error">{error || storageError}</Notice>}
      {!Object.keys(chats).length && <Notice>Your saved conversations appear here.</Notice>}
      {["Today", "Previous 7 days", "Older"].map((group) => {
        const list = Object.values(chats)
          .filter((chat) => chatGroup(chat.updated) === group)
          .sort((a, b) => b.updated - a.updated);
        return list.length ? (
          <details key={group} open={group !== "Older"}>
            <summary>{group}</summary>
            {list.map((chat) => {
              const status =
                chat.run !== null
                  ? "Running"
                  : chat.items.at(-1)?.kind === "error"
                    ? "Failed"
                    : chat.noMosaic
                      ? "Tools disconnected"
                      : null;
              return (
                <div className="chat-history-row" key={chat.id}>
                  <Button
                    className="chat-history-open"
                    data-chat-open
                    aria-current={active === viewPath("chat", chat.id) ? "page" : undefined}
                    disabled={busy || !root}
                    onClick={() => {
                      if (current()) useUi.getState().openView("chat", chat.id);
                    }}
                  >
                    <span>{chat.title}</span>
                    {status && <Badge>{status}</Badge>}
                  </Button>
                  <IconButton
                    label={`Actions for ${chat.title}`}
                    disabled={busy || !root}
                    onClick={(event) => {
                      if (!current()) return;
                      opener.current = event.currentTarget;
                      const bounds = event.currentTarget.getBoundingClientRect();
                      useUi.getState().showMenu(bounds.left, bounds.bottom, [
                        {
                          label: "Rename",
                          action: () =>
                            void act(chat.id, async () => {
                              const title = await useUi.getState().askText({ title: "Rename chat", value: chat.title });
                              if (current() && useChat.getState().chats[chat.id] && title?.trim())
                                useChat.getState().update(chat.id, { title: title.trim() });
                            }),
                        },
                        {
                          label: "Delete chat",
                          danger: true,
                          action: () =>
                            void act(chat.id, async () => {
                              const accepted = await useUi
                                .getState()
                                .ask({ title: "Delete chat?", body: chat.title, confirmLabel: "Delete", danger: true });
                              if (!accepted || !current() || !useChat.getState().chats[chat.id]) return;
                              useChat.getState().remove(chat.id);
                              const workspace = useWorkspace.getState();
                              for (const pane of workspace.panes)
                                if (pane.tabs.includes(viewPath("chat", chat.id)))
                                  workspace.closeTab(pane.id, viewPath("chat", chat.id));
                            }),
                        },
                      ]);
                    }}
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </IconButton>
                </div>
              );
            })}
          </details>
        ) : null;
      })}
    </div>
  );
}
