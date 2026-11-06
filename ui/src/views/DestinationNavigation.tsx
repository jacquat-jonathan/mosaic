import { useEffect, useId, useRef, useState } from "react";
import { Bell, Bot, CalendarDays, Files, Search, Settings } from "lucide-react";
import { Badge, IconButton } from "../design-system/components";
import { useUi, type Destination } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { useUpdateFlow } from "../state/updates";
import { useReview } from "../state/review";
import { useAttention } from "../state/attention";
import { useNotifications } from "../state/notifications";
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
  const updateReady = useUpdateFlow((s) => s.phase === "built");
  const updateAvailable = useUpdateFlow((s) => !!s.check?.update_available);
  const selected = useUi((state) => state.destination);
  const sidebar = useUi((state) => state.leftSidebar);
  const active = useWorkspace((state) => state.panes.find((pane) => pane.id === state.focused)?.active);
  const pending = useReview((state) => state.pending.length);
  const failed = useAttention((state) => state.unseenFailureIds.length);
  const count = pending + failed;
  const unread = useNotifications(
    (state) => state.all.filter((n) => !state.dismissed.has(n.id) && !state.read.has(n.id)).length,
  );
  const attentionDescription = [
    pending ? `${pending} pending ${pending === 1 ? "review" : "reviews"}` : "",
    failed ? `${failed} new failed ${failed === 1 ? "run" : "runs"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
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
                <Badge className="destination-attention" title={attentionDescription} aria-hidden="true">
                  {count > 99 ? "99+" : count}
                </Badge>
                <span id={description} className="destination-description">
                  {attentionDescription}
                </span>
              </>
            )}
          </IconButton>
        ))}
      </div>
      <IconButton
        label={unread ? `Notifications (${unread} unread)` : "Notifications"}
        data-section="Notifications"
        data-section-start="true"
        aria-pressed={active === "mosaic:notifications"}
        onClick={() => useUi.getState().openView("notifications")}
      >
        <Bell aria-hidden="true" />
        {unread > 0 && (
          <Badge className="destination-attention" aria-hidden="true">
            {unread > 99 ? "99+" : unread}
          </Badge>
        )}
      </IconButton>
      <IconButton
        label="Settings"
        data-section="Settings"
        aria-pressed={active === "mosaic:settings"}
        title={`${updateReady ? "Update ready to install · " : updateAvailable ? "Update available · " : ""}Settings (${shortcutOf("settings")})`}
        aria-describedby={updateReady || updateAvailable ? `${description}-update` : undefined}
        onClick={() => useUi.getState().openSettings()}
      >
        <Settings aria-hidden="true" />
        {(updateReady || updateAvailable) && (
          <Badge
            aria-hidden="true"
            className="destination-attention"
            title={updateReady ? "Update ready to install" : "Update available"}
          >
            •
          </Badge>
        )}
      </IconButton>
      {(updateReady || updateAvailable) && (
        <span className="destination-description" id={`${description}-update`}>
          {updateReady ? "Update ready to install" : "Update available"}
        </span>
      )}
    </DesignSystemScope>
  );
}
