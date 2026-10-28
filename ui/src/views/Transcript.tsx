import type { MouseEvent } from "react";
import { Bot, Eye, Pencil } from "lucide-react";
import { renderMarkdown } from "../markdown";
import { resolveLink } from "../links";
import type { ChatItem } from "../state/chat";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { useUi } from "../state/ui";

const noteName = (p: string) => (p.split("/").pop() ?? p).replace(/\.md$/i, "");

export function TranscriptItem({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="chat-msg user">
          {item.agent && (
            <div className="chat-agent">
              <Bot size={11} /> {item.agent}
            </div>
          )}
          {(item.selection || item.model) && (
            <div className="chat-agent">
              {item.selection ? `Selection from ${noteName(item.selection.path)}` : ""}
              {item.selection && item.model ? " · " : ""}
              {item.model ?? ""}
            </div>
          )}
          {item.text}
        </div>
      );
    case "text": {
      const { entries, aliases } = useVault.getState();
      const html = renderMarkdown(item.text, (t) => resolveLink(t, entries, null, aliases));
      // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown output, sanitized by DOMPurify
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
            <button
              className="chat-review"
              onClick={() => useUi.getState().setSidebarTab("activity")}
              title="Waiting for your review in AI activity"
            >
              proposed — review
            </button>
          )}
          {item.error && (
            <span className="chat-tool-error" title={item.error}>
              failed
            </span>
          )}
        </div>
      );
    case "error":
      return <div className="chat-msg error">{item.text}</div>;
  }
}

/** Clicks on [[links]] in answers and on tool lines open the note. */
export function openTranscriptLink(e: MouseEvent) {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-target], [data-path]");
  if (!el) return;
  const { entries, aliases } = useVault.getState();
  const path = el.dataset.path ?? resolveLink(el.dataset.target ?? "", entries, null, aliases);
  if (path && entries.some((x) => x.path === path)) void useWorkspace.getState().open(path, { newTab: true });
}
