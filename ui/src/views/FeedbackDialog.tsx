import { type RefObject, useId, useMemo, useRef, useState } from "react";
import {
  Button,
  Dialog,
  Notice,
  SegmentedControl,
  SettingRow,
  Switch,
  TextArea,
  TextField,
} from "../design-system/components";
import { buildIssueUrl, describeOs, type FeedbackKind, MAX_TITLE_LENGTH } from "../feedback/issueUrl";
import { openExternal } from "../ipc/api";
import { DesignSystemScope } from "./DesignSystemScope";
import "./feedbackDialog.css";

const KINDS = [
  { value: "bug", label: "Bug" },
  { value: "idea", label: "Idea" },
] as const satisfies readonly { value: FeedbackKind; label: string }[];

/** Feedback goes to a prefilled GitHub issue that the person reviews and submits in their browser. */
export function FeedbackDialog({
  version,
  onClose,
  returnFocusRef,
}: {
  version: string;
  onClose(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [includeEnvironment, setIncludeEnvironment] = useState(true);
  const titleInput = useRef<HTMLInputElement>(null);
  const switchId = useId();
  const os = useMemo(() => describeOs(), []);
  const environment = includeEnvironment ? { version: version ? `v${version}` : "", os } : null;
  const issue = buildIssueUrl({ kind, title, message, environment });
  const ready = title.trim().length > 0;
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const submit = async () => {
    if (!ready || sending) return;
    setSending(true);
    setError("");
    try {
      await openExternal(issue.url);
      onClose();
    } catch {
      // Keep what was typed so it can be retried.
      setError("Couldn't open your browser. Try again.");
      setSending(false);
    }
  };
  return (
    <DesignSystemScope>
      <Dialog
        open
        title="Send feedback"
        description="Report a bug or suggest an idea. Mosaic opens a prefilled GitHub issue in your browser for you to review and submit."
        initialFocusRef={titleInput}
        returnFocusRef={returnFocusRef}
        onClose={onClose}
        actions={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" form="mosaic-feedback-form" disabled={!ready || sending}>
              Open in GitHub
            </Button>
          </>
        }
      >
        <form
          id="mosaic-feedback-form"
          className="feedback-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <SegmentedControl<FeedbackKind> label="Feedback type" value={kind} options={KINDS} onChange={setKind} />
          <TextField
            ref={titleInput}
            label="Title"
            value={title}
            maxLength={MAX_TITLE_LENGTH}
            placeholder={kind === "bug" ? "What went wrong?" : "What would you like Mosaic to do?"}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
          <TextArea
            label="Message"
            value={message}
            rows={6}
            placeholder={
              kind === "bug"
                ? "What did you do, what did you expect, and what happened instead?"
                : "Describe the idea and the problem it solves."
            }
            hint="Don't paste private notes: issues can be read by everyone with access to the repository."
            onChange={(event) => setMessage(event.target.value)}
          />
          {error && <Notice tone="error">{error}</Notice>}
          {issue.truncated && (
            <Notice tone="warning">
              This message is too long for a link. It will be shortened; paste the rest in a comment on GitHub.
            </Notice>
          )}
          <SettingRow
            label="Include app version and OS"
            hint={`Adds “Mosaic ${version ? `v${version}` : "(unknown version)"} · ${os}”. Nothing else about your vault or files is sent.`}
            controlId={switchId}
            hintId={`${switchId}-hint`}
          >
            <Switch
              id={switchId}
              label="Include app version and OS"
              checked={includeEnvironment}
              onCheckedChange={setIncludeEnvironment}
              aria-describedby={`${switchId}-hint`}
            />
          </SettingRow>
          <p className="mds-hint feedback-access">
            You need a GitHub account with access to the Mosaic repository to submit the issue.
          </p>
        </form>
      </Dialog>
    </DesignSystemScope>
  );
}
