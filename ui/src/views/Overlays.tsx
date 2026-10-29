import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { flushSync } from "react-dom";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { Button, Dialog, IconButton, Notice, TextField } from "../design-system/components";
import { DesignSystemScope } from "./DesignSystemScope";
import "./errorToast.css";

export { ContextMenu } from "./ContextMenu";

export function ConfirmDialog() {
  const c = useUi((s) => s.confirm);
  // Close the modal before promise continuations restore their explicit opener (Safari).
  const answer = (value: boolean) => flushSync(() => useUi.getState().answer(value));
  const okRef = useRef<HTMLButtonElement>(null);
  if (!c) return null;
  return (
    <DesignSystemScope>
      <Dialog
        open
        title={c.title}
        description={c.body}
        initialFocusRef={okRef}
        onClose={() => answer(false)}
        actions={
          <>
            <Button onClick={() => answer(false)}>Cancel</Button>
            <Button ref={okRef} variant={c.danger ? "danger" : "secondary"} onClick={() => answer(true)}>
              {c.confirmLabel}
            </Button>
          </>
        }
      />
    </DesignSystemScope>
  );
}

export function ErrorToast() {
  const error = useVault((s) => s.error);
  const setError = useVault((s) => s.setError);
  const [paused, setPaused] = useState(false);
  const previous = useRef<Element | null>(null);
  useEffect(() => {
    if (!error) setPaused(false);
    else if (!document.activeElement?.closest(".error-toast-scope")) previous.current = document.activeElement;
  }, [error]);
  useEffect(() => {
    if (!error || paused) return;
    const timer = setTimeout(() => {
      if (useVault.getState().error === error) setError(null);
    }, 6000);
    return () => clearTimeout(timer);
  }, [error, paused, setError]);
  if (!error) return null;
  const dismiss = () => {
    const restore = document.activeElement?.closest(".error-toast-scope");
    setError(null);
    setPaused(false);
    if (restore && previous.current instanceof HTMLElement && previous.current.isConnected) previous.current.focus();
  };
  return (
    <DesignSystemScope
      className="error-toast-scope"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
      onClick={dismiss}
    >
      <Notice tone="error" role="alert">
        <span>{error}</span>
        <IconButton
          label="Dismiss error"
          onClick={(event) => {
            event.stopPropagation();
            dismiss();
          }}
        >
          <X />
        </IconButton>
      </Notice>
    </DesignSystemScope>
  );
}

export function PromptDialog() {
  const p = useUi((s) => s.prompt);
  const answer = (value: string | null) => flushSync(() => useUi.getState().answerText(value));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [p]);
  if (!p) return null;
  return (
    <DesignSystemScope>
      <Dialog
        open
        title={p.title}
        initialFocusRef={input}
        onClose={() => answer(null)}
        actions={
          <>
            <Button onClick={() => answer(null)}>Cancel</Button>
            <Button variant="secondary" type="submit" form="mosaic-prompt-form">
              OK
            </Button>
          </>
        }
      >
        <form
          id="mosaic-prompt-form"
          onSubmit={(e) => {
            e.preventDefault();
            answer(input.current?.value ?? "");
          }}
        >
          <TextField ref={input} label={p.title} defaultValue={p.value} placeholder={p.placeholder} />
        </form>
      </Dialog>
    </DesignSystemScope>
  );
}
