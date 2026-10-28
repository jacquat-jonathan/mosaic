import type { MouseEvent } from "react";
import { Button, Notice } from "../design-system/components";
import { ToolActivity, TranscriptMessage } from "../design-system/patterns";
import { renderMarkdown } from "../markdown";
import { resolveLink } from "../links";
import type { ChatItem } from "../state/chat";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { useUi } from "../state/ui";

import "./transcript.css";

const noteName = (p: string) => (p.split("/").pop() ?? p).replace(/\.md$/i, "");

export function TranscriptItem({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <TranscriptMessage speaker="user">
          {item.agent && <p className="mds-hint">{item.agent}</p>}
          {(item.selection || item.model) && (
            <p className="mds-hint">
              {item.selection ? `Selection from ${noteName(item.selection.path)}` : ""}
              {item.selection && item.model ? " · " : ""}
              {item.model ?? ""}
            </p>
          )}
          {item.text}
        </TranscriptMessage>
      );
    case "text": {
      const { entries, aliases } = useVault.getState();
      const html = renderMarkdown(item.text, (target) => resolveLink(target, entries, null, aliases));
      return (
        <TranscriptMessage speaker="assistant">
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown sanitizes output with DOMPurify */}
          <div className="md-render" dangerouslySetInnerHTML={{ __html: html }} />
        </TranscriptMessage>
      );
    }
    case "tool":
      return (
        <ToolActivity
          summary={item.summary}
          writes={item.writes}
          state={item.error ? "failed" : item.review !== null ? "needs-review" : item.done ? "completed" : "running"}
        >
          {item.path ? (
            <Button variant="secondary" data-path={item.path} aria-label={`Open ${item.path}`}>
              {item.path}
            </Button>
          ) : (
            <p>{item.summary}</p>
          )}
          {item.error && <Notice tone="error">{item.error}</Notice>}
          {item.review !== null && (
            <Button
              variant="secondary"
              onClick={() => useUi.getState().setSidebarTab("activity")}
              title="Waiting for your review in AI activity"
            >
              proposed — review
            </Button>
          )}
        </ToolActivity>
      );
    case "error":
      return <Notice tone="error">{item.text}</Notice>;
  }
}

/** Clicks on [[links]] in answers and on tool lines open the note. */
export function openTranscriptLink(e: MouseEvent, onError?: (cause: unknown) => void) {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-target], [data-path]");
  if (!el) return;
  const { entries, aliases } = useVault.getState();
  const path = el.dataset.path ?? resolveLink(el.dataset.target ?? "", entries, null, aliases);
  if (path && entries.some((x) => x.path === path)) {
    const opening = useWorkspace.getState().open(path, { newTab: true });
    if (onError) void opening.catch(onError);
  }
}
