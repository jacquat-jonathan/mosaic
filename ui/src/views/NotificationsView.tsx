import { AlertTriangle, Bell, CheckCheck, CircleAlert, CircleCheck, Eye, X } from "lucide-react";
import { Button, IconButton, Notice } from "../design-system/components";
import { notificationLabel, type Notification } from "../notifications/registry";
import { useNotifications } from "../state/notifications";
import { useUi } from "../state/ui";
import { ago } from "../time";
import { DesignSystemScope } from "./DesignSystemScope";
import "./notificationsView.css";

const icons = { info: CircleCheck, warning: AlertTriangle, error: CircleAlert };

export function NotificationsView() {
  const all = useNotifications((s) => s.all);
  const read = useNotifications((s) => s.read);
  const dismissed = useNotifications((s) => s.dismissed);
  const items = all.filter((n) => !dismissed.has(n.id));
  const unread = items.filter((n) => !read.has(n.id)).length;
  const open = (n: Notification) => {
    useNotifications.getState().markRead([n.id]);
    useUi.getState().openView(n.target.view, n.target.id);
  };
  return (
    <DesignSystemScope className="workspace-page notifications-view" role="region" aria-label="Notifications">
      <header className="notifications-heading">
        <h1>
          <Bell size={20} aria-hidden="true" /> Notifications
        </h1>
        <div className="notifications-actions">
          <Button disabled={unread === 0} onClick={() => useNotifications.getState().markAllRead()}>
            <CheckCheck size={16} aria-hidden="true" /> Mark all read
          </Button>
          <Button disabled={items.length === 0} onClick={() => useNotifications.getState().dismissAll()}>
            Clear all
          </Button>
        </div>
      </header>
      {items.length === 0 ? (
        <Notice>You're all caught up. Reviews, workflow results and approaching deadlines show up here.</Notice>
      ) : (
        <ul className="notifications-list" aria-label={`${items.length} notifications, ${unread} unread`}>
          {items.map((n) => {
            const Icon = icons[n.severity];
            const isUnread = !read.has(n.id);
            return (
              <li
                key={n.id}
                className="notification"
                data-kind={n.kind}
                data-severity={n.severity}
                data-unread={isUnread}
              >
                <Icon size={18} aria-hidden="true" className="notification-icon" />
                <button type="button" className="notification-body" onClick={() => open(n)}>
                  <span className="notification-title">
                    {isUnread && <span className="notification-dot" role="img" aria-label="Unread" />}
                    {n.title}
                  </span>
                  {n.detail && <span className="notification-detail">{n.detail}</span>}
                  <span className="notification-meta">
                    {notificationLabel(n.kind)}
                    {n.kind !== "task-due-soon" && ` · ${ago(n.at)}`}
                  </span>
                </button>
                {isUnread && (
                  <IconButton label="Mark as read" onClick={() => useNotifications.getState().markRead([n.id])}>
                    <Eye aria-hidden="true" />
                  </IconButton>
                )}
                <IconButton label="Dismiss" onClick={() => useNotifications.getState().dismiss([n.id])}>
                  <X aria-hidden="true" />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
    </DesignSystemScope>
  );
}
