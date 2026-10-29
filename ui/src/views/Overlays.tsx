import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { Button, Dialog, TextField } from "../design-system/components";
import { DesignSystemScope } from "./DesignSystemScope";

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
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error, setError]);
  if (!error) return null;
  return (
    <div className="toast" role="alert" onClick={() => setError(null)}>
      {error}
    </div>
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
