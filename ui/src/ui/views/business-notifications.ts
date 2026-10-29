import { html, nothing } from "lit";
import type { BusinessState } from "../controllers/business";
import {
  emptyBusinessNotifications,
  businessNotificationNavigationBlocked,
} from "../controllers/business-notifications";
import { t, type MessageId } from "../i18n";

export type BusinessNotificationsViewState = {
  business: BusinessState;
  connected: boolean;
  locale: string;
  toggleBusinessNotifications: () => void;
  refreshBusinessNotifications: () => void;
  showMoreBusinessNotifications: () => void;
  openBusinessNotification: (id: string) => void;
  markBusinessNotificationRead: (id: string) => void;
};

export function renderBusinessNotifications(
  state: BusinessNotificationsViewState,
  projectId: string,
) {
  const label = (key: string, params?: Record<string, string | number>) =>
    t(`business.notifications.${key}` as MessageId, params, state.locale);
  const notifications = state.business.notifications ?? emptyBusinessNotifications();
  const sameProject = Boolean(projectId) && state.business.projectId === projectId;
  const connected = state.connected && sameProject;
  const ready =
    connected && !notifications.loading && !notifications.error && notifications.records !== null;
  const records = connected ? (notifications.records ?? []) : [];
  const unread = records.filter((record) => !record.readAt).length;
  const shown = records
    .toSorted(
      (a, b) =>
        Number(a.readAt !== null) - Number(b.readAt !== null) ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )
    .slice(0, notifications.visibleCount);
  const pending = notifications.pendingId !== null;
  const dateLabel = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? label("unknownDate")
      : new Intl.DateTimeFormat(state.locale === "ja" ? "ja" : "en", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(date);
  };
  return html`<section class="business-section" data-business-notifications>
    <button type="button" class="business-refresh" aria-expanded=${notifications.open}
      aria-controls="business-notifications-panel" ?disabled=${!connected} @click=${() => state.toggleBusinessNotifications()}>
      ${label("title")}${ready ? html` <span data-notifications-count>${label("unreadCount", { count: unread })}</span>` : nothing}
    </button>
    ${
      notifications.open
        ? html`<div id="business-notifications-panel" role="region" aria-label=${label("title")}>
      <p class="business-muted">${label("scope")}</p>
      <button type="button" class="business-refresh" ?disabled=${!connected || notifications.loading || pending}
        @click=${() => state.refreshBusinessNotifications()}>${label("refresh")}</button>
      ${!connected ? html`<p role="alert">${label("unavailable")}</p>` : nothing}
      ${connected && notifications.error ? html`<p role="alert">${label(records.length ? "refreshError" : "unavailable")}</p>` : nothing}
      ${connected && notifications.loading ? html`<p role="status">${label("loading")}</p>` : nothing}
      ${connected && !notifications.error && !notifications.loading && !ready ? html`<p role="alert">${label("unavailable")}</p>` : nothing}
      ${ready && records.length === 0 ? html`<p role="status">${label("empty")}</p>` : nothing}
      ${
        records.length === 0
          ? nothing
          : html`<ul class="business-history">${shown.map(
              (record) => html`<li data-notification-id=${record.id}>
          <strong>${label(`reason.${record.reason}`)}</strong>
          <div>${label("item")}: <span class="business-mono business-break">${record.itemId}</span></div>
          ${record.stepKey ? html`<div>${label("step")}: <span class="business-mono business-break">${record.stepKey}</span></div>` : nothing}
          <button type="button" class="business-refresh" data-notification-open=${record.id}
            ?disabled=${!ready || businessNotificationNavigationBlocked(state.business)}
            @click=${() => state.openBusinessNotification(record.id)}>${label("openItem")}</button>
          <time datetime=${record.createdAt}>${dateLabel(record.createdAt)}</time>
          <span>${label(record.readAt ? "read" : "unread")}</span>
          ${
            !record.readAt
              ? html`<button type="button" class="business-refresh" data-notification-mark=${record.id}
            ?disabled=${pending || !ready || notifications.markError}
            @click=${() => state.markBusinessNotificationRead(record.id)}>${label(notifications.pendingId === record.id ? "marking" : "markRead")}</button>`
              : nothing
          }
        </li>`,
            )}</ul>`
      }
      ${connected && records.length > 50 ? html`<p class="business-muted" role="status">${label("retained", { shown: shown.length, total: records.length })}</p>` : nothing}
      ${
        connected && records.length > 50
          ? html`<button type="button" class="business-refresh" data-notifications-more
        ?disabled=${!ready || pending || shown.length >= records.length} @click=${() => state.showMoreBusinessNotifications()}>${label("showMore")}</button>`
          : nothing
      }
      ${connected && notifications.markError ? html`<p role="alert">${label("markError")}</p>` : nothing}
    </div>`
        : nothing
    }
  </section>`;
}
