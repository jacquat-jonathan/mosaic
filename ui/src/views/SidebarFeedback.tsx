import { MessageSquarePlus } from "lucide-react";
import { Button } from "../design-system/components";
import { useFeedback } from "../feedback/store";
import { DesignSystemScope } from "./DesignSystemScope";
import "./sidebarFeedback.css";

/** Pinned to the bottom of the sidebar, below whatever the sidebar shows, so it stays in view. */
export function SidebarFeedback() {
  return (
    <DesignSystemScope className="sidebar-footer">
      <Button
        className="feedback-entry"
        aria-haspopup="dialog"
        onClick={(event) => useFeedback.getState().show(event.currentTarget)}
      >
        <MessageSquarePlus aria-hidden="true" />
        <span>Send feedback</span>
      </Button>
    </DesignSystemScope>
  );
}
