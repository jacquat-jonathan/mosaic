import { MessageSquarePlus } from "lucide-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "../design-system/components";
import { DesignSystemScope } from "./DesignSystemScope";
import { FeedbackDialog } from "./FeedbackDialog";
import "./windowChrome.css";

export function WindowChrome({ vaultName, version }: { vaultName: string; version: string }) {
  const [feedback, setFeedback] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <DesignSystemScope as="header" className="window-chrome" aria-label="Window title" data-tauri-drag-region>
      <span className="window-title" data-tauri-drag-region>
        Mosaic — {vaultName}
      </span>
      <div className="window-meta">
        <span className="window-version" data-tauri-drag-region>
          v{version || "—"}
        </span>
        <IconButton
          ref={button}
          className="window-feedback"
          label="Feedback"
          title="Send feedback"
          aria-haspopup="dialog"
          onClick={() => setFeedback(true)}
        >
          <MessageSquarePlus />
        </IconButton>
      </div>
      {/* Outside the strip, so its drag regions and text styles never reach the dialog. */}
      {feedback &&
        createPortal(
          <FeedbackDialog version={version} returnFocusRef={button} onClose={() => setFeedback(false)} />,
          document.body,
        )}
    </DesignSystemScope>
  );
}
