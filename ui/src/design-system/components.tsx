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

export function IconButton({
  label,
  className,
  title = label,
  ...props
}: Omit<ButtonProps, "aria-label"> & { label: string }) {
  return <Button {...props} aria-label={label} title={title} className={classes("mds-icon-button", className)} />;
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

export function TextArea({
  label,
  hint,
  error,
  id,
  className,
  "aria-describedby": describedBy,
  ...props
}: ComponentPropsWithRef<"textarea"> & { label: string; hint?: string; error?: string }) {
  const generated = useId();
  const fieldId = id ?? generated,
    descriptionId = `${fieldId}-description`;
  return (
    <div className="mds-field">
      <label htmlFor={fieldId}>{label}</label>
      <textarea
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
  "aria-describedby": describedBy,
}: {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  label: string;
  disabled?: boolean;
  id?: string;
  "aria-describedby"?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      className="mds-switch"
      role="switch"
      aria-label={label}
      aria-describedby={describedBy}
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
  id,
  label,
  value,
  options,
  onChange,
  disabled,
  "aria-describedby": describedBy,
}: {
  id?: string;
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  disabled?: boolean;
  "aria-describedby"?: string;
}) {
  const name = useId();
  return (
    <div id={id} className="mds-segmented" role="radiogroup" aria-label={label} aria-describedby={describedBy}>
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
  role,
}: {
  tone?: "neutral" | "warning" | "error";
  children: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div className={`mds-notice mds-notice--${tone}`} role={role ?? (tone === "error" ? "alert" : "status")}>
      {children}
    </div>
  );
}

export function SettingRow({
  label,
  hint,
  controlId,
  hintId,
  children,
}: {
  label: string;
  hint?: string;
  controlId?: string;
  hintId?: string;
  children: ReactNode;
}) {
  return (
    <div className="mds-setting-row">
      <div className="mds-setting-text">
        {controlId ? (
          <label className="mds-label" htmlFor={controlId}>
            {label}
          </label>
        ) : (
          <div className="mds-label">{label}</div>
        )}
        {hint && (
          <div id={hintId} className="mds-hint">
            {hint}
          </div>
        )}
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
  dismissible = true,
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
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [nativeModal] = useState(
    () =>
      typeof HTMLDialogElement !== "undefined" &&
      typeof HTMLDialogElement.prototype.showModal === "function" &&
      typeof HTMLDialogElement.prototype.close === "function",
  );
  useEffect(() => {
    const element = ref.current;
    if (!element || !open) return;
    const previousFocus = returnFocusRef?.current ?? document.activeElement;
    const available = () =>
      [
        ...element.querySelectorAll<HTMLElement>(
          "button, input, select, textarea, summary, a[href], [tabindex], [contenteditable=true]",
        ),
      ].filter((node) => node.tabIndex >= 0 && !node.matches(":disabled") && node.getClientRects().length > 0);
    const focusInside = () => {
      const initial = initialFocusRef?.current;
      (initial && !initial.matches(":disabled") && initial.getClientRects().length
        ? initial
        : (available()[0] ?? element)
      ).focus({ preventScroll: true });
    };
    const hidden: { node: HTMLElement; ariaHidden: string | null; inert: boolean }[] = [];
    const previousOverflow = document.body.style.overflow;
    const keepFocus = (event: FocusEvent) => {
      if (!element.contains(event.target as Node)) focusInside();
    };
    if (nativeModal) {
      element.showModal();
      initialFocusRef?.current?.focus({ preventScroll: true });
    } else {
      element.setAttribute("open", "");
      // Hide every sibling branch along the modal's ancestor path, preserving prior state.
      for (let branch: Element | null = element; branch?.parentElement; branch = branch.parentElement) {
        for (const sibling of branch.parentElement.children) {
          if (
            sibling === branch ||
            !(sibling instanceof HTMLElement) ||
            ["SCRIPT", "STYLE", "LINK"].includes(sibling.tagName)
          )
            continue;
          hidden.push({ node: sibling, ariaHidden: sibling.getAttribute("aria-hidden"), inert: sibling.inert });
          sibling.setAttribute("aria-hidden", "true");
          if ("inert" in sibling) sibling.inert = true;
        }
        if (branch.parentElement === document.body) break;
      }
      document.body.style.overflow = "hidden";
      document.addEventListener("focusin", keepFocus);
      focusInside();
    }
    return () => {
      if (nativeModal) element.close();
      else {
        document.removeEventListener("focusin", keepFocus);
        element.removeAttribute("open");
        document.body.style.overflow = previousOverflow;
        for (const { node, ariaHidden, inert } of hidden) {
          if (ariaHidden === null) node.removeAttribute("aria-hidden");
          else node.setAttribute("aria-hidden", ariaHidden);
          if ("inert" in node) node.inert = inert;
        }
      }
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, [open, returnFocusRef, initialFocusRef, nativeModal]);
  const dialog = (
    <dialog
      ref={ref}
      className={`mds-dialog mds-dialog--${size}${nativeModal ? "" : " mds-dialog--fallback"}`}
      role="dialog"
      aria-modal={open || undefined}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (dismissible) onClose();
          return;
        }
        if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
        const focusable = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "button, input, select, textarea, summary, a[href], [tabindex], [contenteditable=true]",
          ),
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
        if (dismissible) onClose();
      }}
    >
      <header className="mds-dialog-header">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {description && <p id={`${id}-description`}>{description}</p>}
        </div>
        <IconButton label="Close dialog" onClick={onClose} disabled={!dismissible}>
          <X />
        </IconButton>
      </header>
      {children && <div className="mds-dialog-body">{children}</div>}
      <footer className="mds-dialog-actions">{actions}</footer>
    </dialog>
  );
  return nativeModal ? (
    dialog
  ) : (
    <div className="mds-dialog-fallback-backdrop" hidden={!open}>
      {dialog}
    </div>
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
