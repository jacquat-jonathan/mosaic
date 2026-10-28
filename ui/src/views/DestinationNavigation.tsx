import { useEffect, useId, useRef, useState } from "react";
import { Bot, CalendarDays, Files, Search, Settings } from "lucide-react";
import { Badge, IconButton } from "../design-system/components";
import { useUi, type Destination } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { useAttention } from "../state/attention";
import { useChat } from "../state/chat";
import { useReview } from "../state/review";
import { shortcutOf } from "../commands";
import { DesignSystemScope } from "./DesignSystemScope";
import "./destinationNavigation.css";

const destinations: { id: Destination; label: string; section: string; icon: typeof Files }[] = [
  { id: "notes", label: "Files", section: "Files", icon: Files },
  { id: "find", label: "Find", section: "Files", icon: Search },
  { id: "plan", label: "Plan", section: "Plan", icon: CalendarDays },
  { id: "ai", label: "AI", section: "AI", icon: Bot },
];
export function DestinationNavigation() {
  const selected = useUi((state) => state.destination);
  const sidebar = useUi((state) => state.leftSidebar);
  const active = useWorkspace((state) => state.panes.find((pane) => pane.id === state.focused)?.active);
  const pending = useReview((state) => state.pending.length);
  const attention = useAttention((state) => state.count);
  const chatAttention = useChat(
    (state) =>
      Object.values(state.chats).filter(
        (chat) => chat.run === null && (chat.items.at(-1)?.kind === "error" || chat.noMosaic),
      ).length,
  );
  const count = pending + attention + chatAttention;
  const description = `${useId()}-attention`;
  const buttons = useRef(new Map<Destination, HTMLButtonElement>());
  const [focusTarget, setFocusTarget] = useState<Destination | null>(null);
  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget !== selected) {
      setFocusTarget(null);
      return;
    }
    // A newly mounted area may focus its own first field. Arrow navigation stays in the tab list.
    const timer = setTimeout(() => {
      buttons.current.get(focusTarget)?.focus({ preventScroll: true });
      setFocusTarget(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [focusTarget, selected]);
  return (
    <DesignSystemScope
      as="nav"
      className="icon-bar destination-navigation"
      aria-label="Destinations"
      data-focus-region
      tabIndex={-1}
    >
      <div role="tablist" aria-label="Destinations" aria-orientation="vertical" className="destination-group">
        {destinations.map((destination, index) => (
          <IconButton
            key={destination.id}
            label={destination.label}
            ref={(node) => {
              if (node) buttons.current.set(destination.id, node);
              else buttons.current.delete(destination.id);
            }}
            role="tab"
            aria-selected={selected === destination.id}
            tabIndex={selected === destination.id ? 0 : -1}
            aria-describedby={destination.id === "ai" && count > 0 ? description : undefined}
            data-section={destination.section}
            data-section-start={
              index > 0 && destinations[index - 1].section !== destination.section ? "true" : undefined
            }
            title={
              sidebar && selected === destination.id
                ? `${destination.label} — click to hide the sidebar`
                : destination.label
            }
            onClick={() => useUi.getState().selectDestination(destination.id)}
            onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const at =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? destinations.length - 1
                    : (index + (event.key === "ArrowDown" ? 1 : -1) + destinations.length) % destinations.length;
              useUi.setState({ destination: destinations[at].id, leftSidebar: true });
              setFocusTarget(destinations[at].id);
            }}
          >
            <destination.icon aria-hidden="true" />
            {destination.id === "ai" && count > 0 && (
              <>
                <Badge className="destination-attention" title={`${count} need attention`} aria-hidden="true">
                  {count > 99 ? "99+" : count}
                </Badge>
                <span id={description} className="destination-description">
                  {count} need attention
                </span>
              </>
            )}
          </IconButton>
        ))}
      </div>
      <IconButton
        label="Settings"
        data-section="Settings"
        data-section-start="true"
        aria-pressed={active === "mosaic:settings"}
        title={`Settings (${shortcutOf("settings")})`}
        onClick={() => useUi.getState().openSettings()}
      >
        <Settings aria-hidden="true" />
      </IconButton>
    </DesignSystemScope>
  );
}
