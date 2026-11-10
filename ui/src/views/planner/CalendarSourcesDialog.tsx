import { useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import { Button, Dialog, IconButton, Notice, Select, TextField } from "../../design-system/components";
import { api } from "../../ipc/api";
import { errorMessage, type CalendarSubscription } from "../../ipc/types";
import { useVault } from "../../state/vault";
import { DesignSystemScope } from "../DesignSystemScope";
import "./calendarDialogs.css";

export function CalendarSourcesDialog({
  subscriptions,
  onChange,
  onClose,
  returnFocusRef,
}: {
  subscriptions: CalendarSubscription[];
  onChange(): Promise<void>;
  onClose(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const root = useVault((state) => state.vault?.root),
    live = useRef(true),
    lock = useRef(false),
    first = useRef<HTMLInputElement>(null);
  const form = useId();
  const current = () => live.current && root === useVault.getState().vault?.root;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const [name, setName] = useState(""),
    [editing, setEditing] = useState<CalendarSubscription | null>(null),
    [url, setUrl] = useState(""),
    [color, setColor] = useState("#6477d4"),
    [interval, setIntervalValue] = useState(30),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>, focusFirst = false) => {
    if (lock.current || !current()) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    const previous = document.activeElement;
    let succeeded = false;
    try {
      await action();
      if (current()) await onChange();
      succeeded = true;
    } catch (reason) {
      if (current()) setError(errorMessage(reason));
    } finally {
      lock.current = false;
      if (current()) {
        setBusy(false);
        setTimeout(() => {
          if (current() && (document.activeElement === document.body || document.activeElement === previous)) {
            (!(focusFirst && succeeded) &&
            previous instanceof HTMLElement &&
            previous.isConnected &&
            !previous.matches(":disabled")
              ? previous
              : first.current
            )?.focus();
          }
        }, 0);
      }
    }
  };
  const reset = () => {
    setEditing(null);
    setName("");
    setUrl("");
    setColor("#6477d4");
    setIntervalValue(30);
    setError(null);
  };
  const save = () =>
    run(async () => {
      if (editing) {
        await api.updateCalendarSubscription(
          editing.id,
          name,
          color,
          subscriptions.find((item) => item.id === editing.id)?.visible ?? editing.visible,
          interval,
          url.trim() || null,
        );
      } else {
        await api.addCalendarSubscription(name, url, color, interval);
      }
      if (current()) reset();
    }, true);
  return (
    <DesignSystemScope className="calendar-dialog-scope">
      <Dialog
        open
        size="wide"
        title="Calendar subscriptions"
        description="Read-only ICS feeds or calendar pages with a subscription link. Addresses are kept in your macOS Keychain."
        onClose={onClose}
        dismissible={!busy}
        initialFocusRef={first}
        returnFocusRef={returnFocusRef}
        actions={
          <>
            <Button disabled={busy} aria-label="Close calendar subscriptions" onClick={onClose}>
              Close
            </Button>
            <Button disabled={busy} onClick={() => void run(() => api.refreshCalendarSubscriptions(true))}>
              <RefreshCw size={16} /> Refresh all
            </Button>
            {editing && (
              <Button
                disabled={busy}
                onClick={() => {
                  reset();
                  first.current?.focus();
                }}
              >
                Cancel editing
              </Button>
            )}
            <Button
              variant="secondary"
              type="submit"
              form={form}
              disabled={busy || !name.trim() || (!editing && !url.trim())}
            >
              {busy ? "Working…" : editing ? "Save changes" : "Add calendar"}
            </Button>
          </>
        }
      >
        <div className="calendar-source-list" role="list" aria-label="Calendar subscriptions">
          {!subscriptions.length && <p className="mds-hint">No external calendars yet.</p>}
          {subscriptions.map((item) => (
            <article role="listitem" key={item.id} style={{ "--source-color": item.color } as CSSProperties}>
              <div className="calendar-source-info">
                <label>
                  <input
                    type="checkbox"
                    checked={item.visible}
                    disabled={busy}
                    onChange={(event) =>
                      void run(() =>
                        api.updateCalendarSubscription(
                          item.id,
                          item.name,
                          item.color,
                          event.target.checked,
                          item.refresh_minutes,
                          null,
                        ),
                      )
                    }
                  />
                  <strong>{item.name}</strong>
                </label>
                <p className="mds-hint">
                  {item.has_cache
                    ? item.last_success
                      ? `Updated ${new Date(item.last_success).toLocaleString()}`
                      : "Cached"
                    : "Not cached yet"}
                </p>
                {item.last_error && <Notice tone="warning">{item.last_error}</Notice>}
              </div>
              <IconButton
                label={`Edit ${item.name}`}
                disabled={busy}
                onClick={() => {
                  setEditing(item);
                  setName(item.name);
                  setUrl("");
                  setColor(item.color);
                  setIntervalValue(item.refresh_minutes);
                  setError(null);
                  first.current?.focus();
                }}
              >
                <Pencil size={16} />
              </IconButton>
              <IconButton
                label={`Remove ${item.name}`}
                disabled={busy}
                onClick={() => void run(() => api.removeCalendarSubscription(item.id), true)}
              >
                <Trash2 size={16} />
              </IconButton>
            </article>
          ))}
        </div>
        <form
          id={form}
          className="calendar-source-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          aria-busy={busy}
        >
          <h3>{editing ? `Edit ${editing.name}` : "Add subscription"}</h3>
          <TextField
            ref={first}
            label="Name"
            value={name}
            required
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            placeholder="Team calendar"
          />
          <TextField
            label={editing ? "Replacement URL (optional)" : "Subscription URL"}
            value={url}
            required={!editing}
            type="url"
            disabled={busy}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://… or webcal://…"
          />
          {editing && <p className="mds-hint">Leave the URL blank to keep the current address.</p>}
          <div className="calendar-dialog-fields">
            <TextField
              label="Color"
              type="color"
              value={color}
              disabled={busy}
              onChange={(event) => setColor(event.target.value)}
            />
            <Select
              label="Refresh"
              value={interval}
              disabled={busy}
              onChange={(event) => setIntervalValue(Number(event.target.value))}
            >
              <option value={5}>5 minutes</option>
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={60}>Hourly</option>
            </Select>
          </div>
          {error && <Notice tone="error">{error}</Notice>}
        </form>
      </Dialog>
    </DesignSystemScope>
  );
}
