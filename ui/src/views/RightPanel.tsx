import { X } from "lucide-react";
import { contextKind, parseView } from "./specialTabs";
import { useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { useUi } from "../state/ui";
import { ChatContext } from "./ChatContext";
import { usePlanning } from "../state/planning";
import { WorkflowContext } from "./Workflows";

import { CalendarContext } from "./CalendarContext";
import { NoteDetails } from "./NoteDetails";
import { IconButton } from "../design-system/components";
import { DesignSystemScope } from "./DesignSystemScope";
import "./noteDetails.css";

/** Context follows the focused workspace, independently of the selected destination. */
export function RightPanel() {
  const active = useWorkspace((s) => s.panes.find((p) => p.id === s.focused)?.active ?? null);
  const kind = contextKind(active);
  const root = useVault((s) => s.vault?.root);
  const day = usePlanning((s) => s.selectedDay);
  if (!active || !kind) return null;
  const id = parseView(active).id;
  return (
    <aside className="right-panel" aria-label="Workspace context" data-focus-region tabIndex={-1}>
      <DesignSystemScope as="header" className="context-head note-details-header">
        <strong>{kind === "note" ? "Note details" : `${kind[0].toUpperCase()}${kind.slice(1)} details`}</strong>
        <IconButton
          label="Close context panel"
          onClick={() => {
            useUi.getState().toggleRightPanel();
            requestAnimationFrame(() => {
              const pane =
                document.querySelector<HTMLElement>(".pane.focused") ?? document.querySelector<HTMLElement>(".pane");
              const control = pane?.querySelector<HTMLButtonElement>('[aria-label="Show right panel"]');
              (control?.getClientRects().length
                ? control
                : pane?.querySelector<HTMLButtonElement>('[aria-label="More workspace actions"]')
              )?.focus();
            });
          }}
        >
          <X aria-hidden="true" />
        </IconButton>
      </DesignSystemScope>
      {kind === "note" ? (
        <NoteDetails key={`${root}/${active}`} path={active} />
      ) : kind === "chat" ? (
        <ChatContext id={id} />
      ) : kind === "workflow" ? (
        <WorkflowContext name={id} />
      ) : (
        <CalendarContext key={`${root}/${day}`} />
      )}
    </aside>
  );
}
