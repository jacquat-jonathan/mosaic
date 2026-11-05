import { useEffect, useId, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ArrowUp, ArrowDown, Plus, LockKeyhole } from "lucide-react";
import { Badge, Button, IconButton, MenuButton } from "./components";

type ColorStyle = CSSProperties & { "--mds-planning-color"?: string };
const colorStyle = (color?: string): ColorStyle => ({ "--mds-planning-color": color ?? "var(--mds-accent)" });

/** Layout and presentation only. The consumer owns task state and drag/drop behavior. */
export function BoardGrid({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mds-board-grid" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

export function BoardColumn({
  title,
  count,
  dropTarget,
  children,
  label,
  headingLevel = 4,
  ...dropEvents
}: {
  title: string;
  count: number;
  dropTarget?: boolean;
  children: ReactNode;
  label?: string;
  headingLevel?: 3 | 4;
} & Pick<HTMLAttributes<HTMLElement>, "onDragOver" | "onDragLeave" | "onDrop">) {
  const id = useId();
  const Heading = headingLevel === 3 ? "h3" : "h4";
  return (
    <section
      {...dropEvents}
      className="mds-board-column"
      aria-label={label}
      aria-labelledby={label ? undefined : id}
      data-drop-target={dropTarget || undefined}
    >
      <header>
        <Heading id={id}>{title}</Heading>
        <Badge aria-label={`${count} tasks`}>{count}</Badge>
      </header>
      <div className="mds-board-column-body">{children}</div>
    </section>
  );
}

export function BoardDropIndicator({ label = "Drop task here", active = false }: { label?: string; active?: boolean }) {
  return (
    <div className="mds-board-drop" data-active={active || undefined}>
      {label}
    </div>
  );
}

/** The complete epic is the drag surface; embedded controls keep their normal interactions. */
export function EpicLane({
  title,
  draggable = false,
  dragging,
  dropPosition,
  children,
  onDragStart,
  ...dragEvents
}: {
  title: string;
  draggable?: boolean;
  dragging?: boolean;
  dropPosition?: "before" | "after";
  children: ReactNode;
} & Pick<HTMLAttributes<HTMLElement>, "onDragStart" | "onDragEnd" | "onDragOver" | "onDrop">) {
  const fromControl = useRef(false);
  return (
    <section
      {...dragEvents}
      className="mds-epic-lane"
      aria-label={`${title} epic`}
      draggable={draggable}
      data-dragging={dragging || undefined}
      data-drop-position={dropPosition}
      onPointerDownCapture={(event) => {
        fromControl.current = !!(event.target as HTMLElement).closest(
          "button,input,select,textarea,a,[contenteditable=true]",
        );
      }}
      onDragStart={(event) => {
        if ((event.target as HTMLElement).closest('[draggable="true"]') !== event.currentTarget) return;
        if (fromControl.current) {
          event.preventDefault();
          return;
        }
        onDragStart?.(event);
      }}
    >
      {children}
    </section>
  );
}

export function EpicHeader({
  title,
  count,
  color,
  expanded,
  onExpandedChange,
  onMoveUp,
  onMoveDown,
  onCreateTask,
  actions,
  headingLevel = 3,
  reorderDisabled = false,
}: {
  title: string;
  count: number;
  color?: string;
  expanded: boolean;
  onExpandedChange(expanded: boolean): void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onCreateTask?: () => void;
  actions?: ReactNode;
  headingLevel?: 2 | 3;
  reorderDisabled?: boolean;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <header className="mds-epic-header" style={colorStyle(color)}>
      <IconButton
        label={`${expanded ? "Collapse" : "Expand"} ${title}`}
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
      >
        {expanded ? <ChevronDown /> : <ChevronRight />}
      </IconButton>
      <Heading>{title}</Heading>
      <span className="mds-hint">{count} tasks</span>
      <span className="mds-epic-actions">
        {onCreateTask && (
          <Button
            aria-label={`Add task to ${title}`}
            onClick={(event) => {
              event.currentTarget.focus();
              onCreateTask();
            }}
          >
            <Plus aria-hidden="true" />
            Task
          </Button>
        )}
        {(onMoveUp || onMoveDown) && (
          <>
            <IconButton label={`Move ${title} up`} disabled={reorderDisabled || !onMoveUp} onClick={onMoveUp}>
              <ArrowUp />
            </IconButton>
            <IconButton label={`Move ${title} down`} disabled={reorderDisabled || !onMoveDown} onClick={onMoveDown}>
              <ArrowDown />
            </IconButton>
          </>
        )}
        {actions}
      </span>
    </header>
  );
}

export function BoardCard({
  title,
  description,
  metadata,
  selected,
  disabled,
  onOpen,
  children,
  actions,
  draggable = false,
  dragging,
  id,
  onDragStart,
  onDragEnd,
  onKeyDown,
  className,
  ...cardProps
}: {
  title: string;
  description?: string;
  metadata?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onOpen(): void;
  children?: ReactNode;
  actions?: ReactNode;
  draggable?: boolean;
  dragging?: boolean;
  id?: string;
} & Omit<HTMLAttributes<HTMLElement>, "title">) {
  const fromControl = useRef(false);
  return (
    <article
      {...cardProps}
      id={id}
      className={["mds-board-card", className].filter(Boolean).join(" ")}
      aria-label={title}
      data-selected={selected || undefined}
      draggable={draggable && !disabled}
      data-dragging={dragging || undefined}
      onKeyDown={onKeyDown}
      onPointerDownCapture={(event) => {
        fromControl.current = !!(event.target as HTMLElement).closest(
          "button:not(.mds-board-card-title),input,select,textarea,a,[contenteditable=true]",
        );
      }}
      onDragStart={(event) => {
        event.stopPropagation();
        if (disabled || fromControl.current) {
          event.preventDefault();
          return;
        }
        onDragStart?.(event);
      }}
      onDragEnd={(event) => {
        event.stopPropagation();
        onDragEnd?.(event);
      }}
    >
      <Button className="mds-board-card-title" aria-pressed={!!selected} disabled={disabled} onClick={onOpen}>
        {title}
      </Button>
      {description && <p>{description}</p>}
      {metadata && <div className="mds-planning-meta">{metadata}</div>}
      {children}
      {actions && <footer>{actions}</footer>}
    </article>
  );
}

export function PlannerExportMenu({
  label = "Export plan",
  onExport,
}: {
  label?: string;
  onExport(format: "json" | "csv"): void;
}) {
  return (
    <MenuButton
      label={label}
      items={[
        { id: "json", label: "JSON export", onSelect: () => onExport("json") },
        { id: "csv", label: "CSV table", onSelect: () => onExport("csv") },
      ]}
    />
  );
}

export type CalendarLayer = {
  id: string;
  label: string;
  visible: boolean;
  color?: string;
  readOnly?: boolean;
  disabled?: boolean;
};

/** A disclosure containing form controls: normal Tab order, Escape and outside dismissal. */
export function CalendarChooser({
  label = "Calendars",
  layers,
  onVisibilityChange,
  actions,
}: {
  label?: string;
  layers: readonly CalendarLayer[];
  onVisibilityChange(id: string, visible: boolean): void;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [open]);
  return (
    <div
      ref={anchor}
      className="mds-calendar-chooser"
      onBlur={(event) => {
        // WebKit may report null while a pointer moves focus to a checkbox.
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <Button
        ref={trigger}
        variant="secondary"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(event) => {
          // Safari pointer activation does not focus buttons by default.
          event.currentTarget.focus();
          setOpen(!open);
        }}
      >
        {label}
        <ChevronDown aria-hidden="true" />
      </Button>
      {open && (
        <div id={id} className="mds-calendar-layers" role="group" aria-label={label}>
          {layers.map((layer) => (
            <label key={layer.id} style={colorStyle(layer.color)}>
              <input
                type="checkbox"
                checked={layer.visible}
                disabled={layer.disabled}
                onClick={(event) => event.currentTarget.focus()}
                onChange={(event) => onVisibilityChange(layer.id, event.target.checked)}
              />
              <span className="mds-planning-dot" aria-hidden="true" />
              <span>{layer.label}</span>
              {layer.readOnly && (
                <>
                  <LockKeyhole size={14} aria-hidden="true" />
                  <span className="mds-planning-sr-only">Read only</span>
                </>
              )}
            </label>
          ))}
          {actions && <footer>{actions}</footer>}
        </div>
      )}
    </div>
  );
}

export function CalendarChip({
  title,
  time,
  kind = "event",
  color,
  selected,
  readOnly,
  disabled,
  onOpen,
}: {
  title: string;
  time?: string;
  kind?: "event" | "session" | "due";
  color?: string;
  selected?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  onOpen(): void;
}) {
  return (
    <button
      type="button"
      className={`mds-calendar-chip mds-calendar-chip--${kind}`}
      style={colorStyle(color)}
      data-selected={selected || undefined}
      aria-pressed={!!selected}
      disabled={disabled}
      onClick={onOpen}
    >
      {time && <span className="mds-calendar-chip-time">{time}</span>}
      <strong>{title}</strong>
      <span className="mds-calendar-chip-kind">
        {kind === "session" ? "Work session" : kind === "due" ? "Due date" : "Event"}
        {readOnly && (
          <>
            {" "}
            · <LockKeyhole size={12} aria-hidden="true" /> Read only
          </>
        )}
      </span>
    </button>
  );
}

export function CalendarGrid({
  label,
  columns = 7,
  children,
}: {
  label: string;
  columns?: 1 | 5 | 7;
  children: ReactNode;
}) {
  return (
    <div
      className="mds-calendar-grid"
      role="region"
      aria-label={label}
      tabIndex={0}
      style={{ "--mds-calendar-columns": columns } as CSSProperties}
    >
      {children}
    </div>
  );
}

export function CalendarDay({
  label,
  date,
  today,
  selected,
  onOpen,
  children,
}: {
  label: string;
  date: string;
  today?: boolean;
  selected?: boolean;
  onOpen(): void;
  children?: ReactNode;
}) {
  return (
    <section className="mds-calendar-day" aria-label={label} data-today={today || undefined}>
      <Button
        className="mds-calendar-day-heading"
        aria-label={`Open ${label}`}
        aria-pressed={!!selected}
        aria-current={today ? "date" : undefined}
        onClick={onOpen}
      >
        {date}
      </Button>
      <div className="mds-calendar-day-items">{children}</div>
    </section>
  );
}

export function CalendarSessionMenu({
  label = "Session actions",
  onEdit,
  onUnschedule,
  disabled = false,
}: {
  label?: string;
  onEdit(): void;
  onUnschedule(): void;
  disabled?: boolean;
}) {
  return (
    <MenuButton
      label={label}
      items={[
        { id: "edit", label: "Edit work session", disabled, onSelect: onEdit },
        { id: "unschedule", label: "Unschedule session", danger: true, disabled, onSelect: onUnschedule },
      ]}
    />
  );
}

export function TaskTray({
  title = "Open tasks",
  count,
  collapsed,
  onCollapsedChange,
  filters,
  children,
}: {
  title?: string;
  count: number;
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
  filters?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <aside className="mds-task-tray" aria-label={title}>
      <header>
        <IconButton
          label={`${collapsed ? "Show" : "Hide"} ${title.toLowerCase()}`}
          aria-expanded={!collapsed}
          aria-controls={!collapsed ? id : undefined}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? <ChevronRight /> : <ChevronDown />}
        </IconButton>
        <h3>{title}</h3>
        <Badge>{count}</Badge>
      </header>
      {!collapsed && (
        <div id={id} className="mds-task-tray-body">
          {filters}
          {children}
        </div>
      )}
    </aside>
  );
}

export function TaskTrayGroup({
  title,
  count,
  color,
  children,
}: {
  title: string;
  count: number;
  color?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="mds-task-tray-group" style={colorStyle(color)} aria-labelledby={id}>
      <h4 id={id}>
        <span className="mds-planning-dot" aria-hidden="true" />
        {title}
        <Badge>{count}</Badge>
      </h4>
      <div>{children}</div>
    </section>
  );
}

export function TaskTrayItem({
  title,
  metadata,
  disabled,
  onSchedule,
}: {
  title: string;
  metadata?: string;
  disabled?: boolean;
  onSchedule(): void;
}) {
  return (
    <Button className="mds-task-tray-item" aria-label={`Schedule ${title}`} disabled={disabled} onClick={onSchedule}>
      <strong>{title}</strong>
      {metadata && <span className="mds-planning-meta">{metadata}</span>}
    </Button>
  );
}
