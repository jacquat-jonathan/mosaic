import {
  useEffect,
  useId,
  useRef,
  useState,
  cloneElement,
  type ComponentPropsWithRef,
  type HTMLAttributes,
  type ReactNode,
  type ReactElement,
  type RefObject,
  type SelectHTMLAttributes,
} from "react";
import { ChevronDown, X } from "lucide-react";

const classes = (...values: (string | undefined | false)[]) => values.filter(Boolean).join(" ");

export type ButtonProps = ComponentPropsWithRef<"button"> & {
  variant?: "quiet" | "secondary" | "primary" | "danger" | "danger-primary";
};

export function Button({ variant = "quiet", className, type = "button", ...props }: ButtonProps) {
  return <button {...props} type={type} className={classes("mds-button", `mds-button--${variant}`, className)} />;
}

export function IconButton({ label, className, ...props }: Omit<ButtonProps, "aria-label"> & { label: string }) {
  return <Button {...props} aria-label={label} title={label} className={classes("mds-icon-button", className)} />;
}

export function TextField({
  label,
  hint,
  error,
  id,
  className,
  "aria-describedby": describedBy,
  ...props
}: ComponentPropsWithRef<"input"> & { label: string; hint?: string; error?: string }) {
  const generated = useId();
  const fieldId = id ?? generated;
  const descriptionId = `${fieldId}-description`;
  return (
    <div className="mds-field">
      <label htmlFor={fieldId}>{label}</label>
      <input
        {...props}
        id={fieldId}
        className={classes("mds-input", className)}
        aria-invalid={error ? true : props["aria-invalid"]}
        aria-describedby={classes(describedBy, (error || hint) && descriptionId) || undefined}
      />
      {(error || hint) && (
        <span id={descriptionId} className={error ? "mds-field-error" : "mds-hint"}>
          {error || hint}
        </span>
      )}
    </div>
  );
}

export function Select({
  label,
  id,
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
}) {
  const generated = useId();
  return (
    <div className="mds-field">
      <label htmlFor={id ?? generated}>{label}</label>
      <select {...props} id={id ?? generated} className={classes("mds-input", className)}>
        {children}
      </select>
    </div>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      className="mds-switch"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    >
      <span />
    </button>
  );
}

/** Single-choice controls use native radios, including arrow-key navigation and form semantics. */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <div className="mds-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

export function Badge({ children, className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...props} className={classes("mds-badge", className)}>
      {children}
    </span>
  );
}

export function Notice({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "warning" | "error";
  children: ReactNode;
}) {
  return (
    <div className={`mds-notice mds-notice--${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mds-setting-row">
      <div className="mds-setting-text">
        <div className="mds-label">{label}</div>
        {hint && <div className="mds-hint">{hint}</div>}
      </div>
      <div className="mds-setting-control">{children}</div>
    </div>
  );
}

export function Toolbar({ label, children }: { label: string; children: ReactNode }) {
  // A labelled group uses normal Tab order; it does not promise a roving-focus ARIA toolbar.
  return (
    <div className="mds-toolbar" role="group" aria-label={label}>
      {children}
    </div>
  );
}

export function Tooltip({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ "aria-describedby"?: string }>;
}) {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  return (
    <span
      className="mds-tooltip-anchor"
      onMouseEnter={() => setDismissed(false)}
      onFocus={() => setDismissed(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setDismissed(true);
      }}
    >
      {cloneElement(children, { "aria-describedby": classes(children.props["aria-describedby"], id) })}
      <span id={id} role="tooltip" className="mds-tooltip" data-dismissed={dismissed || undefined}>
        {label}
      </span>
    </span>
  );
}

export function Dialog({
  open,
  title,
  description,
  children,
  actions,
  onClose,
  returnFocusRef,
  initialFocusRef,
  size = "default",
}: {
  open: boolean;
  title: string;
  description?: string;
  children?: ReactNode;
  actions: ReactNode;
  onClose(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  size?: "default" | "wide";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const element = ref.current;
    if (!element || !open) return;
    const previousFocus = returnFocusRef?.current ?? document.activeElement;
    element.showModal();
    initialFocusRef?.current?.focus({ preventScroll: true });
    return () => {
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, [open, returnFocusRef, initialFocusRef]);
  return (
    <dialog
      ref={ref}
      className={`mds-dialog mds-dialog--${size}`}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
        const focusable = [
          ...event.currentTarget.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]"),
        ].filter(
          (element) => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0,
        );
        // Safari's Tab preference can skip buttons. Keep the modal sequence explicit.
        event.preventDefault();
        const current = focusable.indexOf(document.activeElement as HTMLElement);
        const next =
          current < 0
            ? event.shiftKey
              ? focusable.length - 1
              : 0
            : (current + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
        (focusable[next] ?? event.currentTarget).focus();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="mds-dialog-header">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {description && <p id={`${id}-description`}>{description}</p>}
        </div>
        <IconButton label="Close dialog" onClick={onClose}>
          <X />
        </IconButton>
      </header>
      {children && <div className="mds-dialog-body">{children}</div>}
      <footer className="mds-dialog-actions">{actions}</footer>
    </dialog>
  );
}

export type MenuAction = {
  id: string;
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect(): void;
};

/** Single-level action menu; nested/context menus are intentionally outside this first candidate. */
export function MenuButton({ label, items }: { label: string; items: readonly MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const initialFocus = useRef<"first" | "last" | "menu">("menu");
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const buttons = menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    if (initialFocus.current === "menu" || !buttons?.length) menu.current?.focus();
    else buttons[initialFocus.current === "last" ? buttons.length - 1 : 0]?.focus();
    const outside = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div ref={anchor} className="mds-menu-anchor">
      <Button
        ref={trigger}
        variant="secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(event) => {
          initialFocus.current = event.detail === 0 ? "first" : "menu";
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            initialFocus.current = event.key === "ArrowUp" ? "last" : "first";
            setOpen(true);
          }
        }}
      >
        {label}
        <ChevronDown className="mds-menu-chevron" aria-hidden="true" />
      </Button>
      {open && (
        <div
          ref={menu}
          id={id}
          className="mds-menu"
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
              const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : current < 0
                      ? event.key === "ArrowUp"
                        ? buttons.length - 1
                        : 0
                      : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }
          }}
        >
          {items.map((item) => (
            <div key={item.id} role="none">
              {item.separatorBefore && <div className="mds-menu-separator" role="separator" />}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                className={item.danger ? "mds-menu-danger" : undefined}
                onPointerMove={(event) => {
                  if (event.pointerType !== "touch" && !item.disabled)
                    event.currentTarget.focus({ preventScroll: true });
                }}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
              >
                <span>{item.label}</span>
                {item.shortcut && <kbd>{item.shortcut}</kbd>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
