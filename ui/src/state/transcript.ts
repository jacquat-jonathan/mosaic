import type { ChatEvent } from "../ipc/types";
import type { ChatItem } from "./chat";

/** Chats and saved workflow logs use the same visible events and tool outcomes. */
export function appendTranscriptEvent(items: ChatItem[], event: ChatEvent): ChatItem[] {
  switch (event.kind) {
    case "text":
      return [...items, { kind: "text", text: event.text }];
    case "tool":
      return [...items, { ...event, error: null, review: null, done: false }];
    case "tool_done":
      return items.map((item) =>
        item.kind === "tool" && item.id === event.id
          ? { ...item, error: event.error, review: event.review, done: true }
          : item,
      );
    case "done":
      return event.error ? [...items, { kind: "error", text: event.error }] : items;
    default:
      return items;
  }
}
