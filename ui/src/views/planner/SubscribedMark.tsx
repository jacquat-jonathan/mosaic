import { CalendarSync } from "lucide-react";

/** Sets events from a subscribed (read-only) calendar apart from local events of the same color. */
export function SubscribedMark() {
  return <CalendarSync className="planner-overlay-mark" size={10} strokeWidth={2.5} aria-hidden="true" />;
}
