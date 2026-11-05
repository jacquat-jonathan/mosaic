import { useState } from "react";
import { Button, Notice } from "../design-system/components";
import { StatusLabel } from "../design-system/patterns";
import { errorMessage } from "../ipc/types";
import { useChat } from "../state/chat";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { DesignSystemScope } from "./DesignSystemScope";
import "../design-system/patterns.css";
import "./chatPanel.css";
import "./workflowStatus.css";

export function ChatContext({ id }: { id: string }) {
  const root = useChat((state) => state.root);
  return <Context key={`${root}:${id}`} id={id} root={root} />;
}
function Context({ id, root }: { id: string; root: string | null }) {
  const chat = useChat((state) => state.chats[id]);
  const [error, setError] = useState<string | null>(null);
  const last = chat?.items.findLast((item) => item.kind === "user");
  const selection = chat?.selection || (last?.kind === "user" ? last.selection : null);
  return (
    <DesignSystemScope
      className="context-content chat-context workflow-status-scope"
      role="group"
      aria-label="Chat context"
    >
      {!chat ? (
        <Notice>Chat unavailable.</Notice>
      ) : (
        <>
          <h3>Attachments</h3>
          {chat.attached.length ? (
            chat.attached.map((path) => (
              <Button
                variant="secondary"
                key={path}
                onClick={() => {
                  if (!root || useChat.getState().root !== root || useVault.getState().vault?.root !== root) return;
                  setError(null);
                  void useWorkspace
                    .getState()
                    .open(path, { newTab: true })
                    .catch((cause) => {
                      if (useChat.getState().root === root) setError(errorMessage(cause));
                    });
                }}
              >
                {path}
              </Button>
            ))
          ) : (
            <p className="mds-hint">No attached files.</p>
          )}
          {selection && (
            <>
              <h3>Selection</h3>
              <blockquote>{selection.text}</blockquote>
            </>
          )}
          <dl className="mds-metadata">
            {[
              ["Provider", "Claude Code"],
              ["Model", chat.model || "Default"],
              ["Session", chat.session || "Not started"],
              ["Cost", `$${chat.cost.toFixed(2)}`],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            <div>
              <dt>Status</dt>
              <dd>
                {chat.run !== null ? (
                  <StatusLabel state="running" />
                ) : chat.noMosaic ? (
                  "Tools disconnected"
                ) : (
                  <StatusLabel state="ready" />
                )}
              </dd>
            </div>
          </dl>
          {last?.kind === "user" && (
            <>
              <h3>Last message context</h3>
              {last.context.map((path) => (
                <p key={path}>{path}</p>
              ))}
            </>
          )}
          {error && <Notice tone="error">{error}</Notice>}
        </>
      )}
    </DesignSystemScope>
  );
}
