import type { WorkitemsNotificationsListResult } from "../../../../packages/client/src/generated/types";
import type { BusinessHost, BusinessState } from "./business";

export type BusinessNotifications = {
  open: boolean;
  visibleCount: number;
  loading: boolean;
  error: boolean;
  records: WorkitemsNotificationsListResult["notifications"] | null;
  pendingId: string | null;
  markError: boolean;
};

export const emptyBusinessNotifications = (): BusinessNotifications => ({
  open: false,
  visibleCount: 50,
  loading: false,
  error: false,
  records: null,
  pendingId: null,
  markError: false,
});

const loads = new WeakMap<BusinessHost, object>();
// Navigation resets presentation, but must never permit a second unresolved write.
const writes = new WeakSet<BusinessHost>();
const reasons = new Set([
  "awaiting_you",
  "delegated_to_you",
  "escalated_to_you",
  "delegation_withdrawn",
  "decided",
  "linked_step_ready",
  "linked_case_complete",
  "linked_case_blocked",
]);
type Notification = WorkitemsNotificationsListResult["notifications"][number];
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function date(value: unknown): value is string {
  return text(value) && Number.isFinite(Date.parse(value));
}
function notification(value: unknown): value is Notification {
  return (
    object(value) &&
    text(value.id) &&
    text(value.principal) &&
    text(value.itemId) &&
    typeof value.reason === "string" &&
    reasons.has(value.reason) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    date(value.createdAt) &&
    (value.readAt === null || date(value.readAt)) &&
    (value.childId === undefined || text(value.childId)) &&
    (value.stepKey === undefined || text(value.stepKey))
  );
}
function active(host: BusinessHost) {
  return (
    host.connected &&
    host.client &&
    host.tab === "projects" &&
    host.projects.view === "business" &&
    host.projects.selectedId &&
    host.projects.selectedId === host.business.projectId
  );
}
function patch(
  host: BusinessHost,
  state: BusinessNotifications,
  next: Partial<BusinessNotifications>,
) {
  Object.assign(state, next);
  host.business = { ...host.business, notifications: state };
}
function context(host: BusinessHost) {
  const client = host.client;
  if (!client || !active(host)) {
    return null;
  }
  const projectId = host.business.projectId!;
  const state = host.business.notifications;
  return {
    client,
    projectId,
    state,
    current: () =>
      active(host) &&
      host.client === client &&
      host.business.projectId === projectId &&
      host.business.notifications === state,
  };
}

export async function loadBusinessNotifications(host: BusinessHost) {
  const ctx = context(host);
  if (!ctx) {
    return;
  }
  const token = {};
  loads.set(host, token);
  const current = () => ctx.current() && loads.get(host) === token;
  patch(host, ctx.state, { loading: true, error: false });
  try {
    const result: unknown = await ctx.client.request("workitems.notifications.list", {
      projectId: ctx.projectId,
    });
    if (!current()) {
      return;
    }
    if (
      !object(result) ||
      !Array.isArray(result.notifications) ||
      !result.notifications.every(notification) ||
      new Set(result.notifications.map((record) => record.id)).size !== result.notifications.length
    ) {
      throw new Error("Invalid notifications");
    }
    patch(host, ctx.state, { loading: false, records: result.notifications, markError: false });
  } catch {
    if (current()) {
      patch(host, ctx.state, { loading: false, error: true });
    }
  }
}

// The RPC returns the retained inbox in full; pagination is presentation-only.
export function showMoreBusinessNotifications(host: BusinessHost) {
  const ctx = context(host);
  if (!ctx || !ctx.state.open || ctx.state.loading || ctx.state.error) {
    return;
  }
  patch(host, ctx.state, {
    visibleCount: Math.min(ctx.state.visibleCount + 50, ctx.state.records?.length ?? 50),
  });
}

export async function toggleBusinessNotifications(host: BusinessHost) {
  const ctx = context(host);
  if (!ctx) {
    return;
  }
  patch(host, ctx.state, { open: !ctx.state.open });
  if (ctx.state.open) {
    await loadBusinessNotifications(host);
  }
}

export async function markBusinessNotificationRead(host: BusinessHost, id: string) {
  const ctx = context(host);
  const record = ctx?.state.records?.find((entry) => entry.id === id && entry.readAt === null);
  if (
    !ctx ||
    !record ||
    ctx.state.loading ||
    ctx.state.error ||
    ctx.state.markError ||
    writes.has(host)
  ) {
    return;
  }
  writes.add(host);
  patch(host, ctx.state, { pendingId: id, markError: false });
  try {
    const result: unknown = await ctx.client.request("workitems.notifications.markRead", {
      projectId: ctx.projectId,
      id,
    });
    if (!ctx.current()) {
      return;
    }
    if (
      !object(result) ||
      !notification(result.notification) ||
      result.notification.id !== id ||
      result.notification.itemId !== record.itemId ||
      result.notification.principal !== record.principal ||
      result.notification.readAt === null
    ) {
      throw new Error("Invalid notification acknowledgement");
    }
    const acknowledged = result.notification;
    patch(host, ctx.state, {
      records: ctx.state.records?.map((entry) => (entry.id === id ? acknowledged : entry)) ?? null,
    });
    await loadBusinessNotifications(host);
  } catch {
    if (ctx.current()) {
      patch(host, ctx.state, { markError: true });
    }
  } finally {
    writes.delete(host);
    // Release presentation state even when the request settles on another tab.
    // Data and errors remain scope-guarded above; a reset owns a different object.
    if (host.business.notifications === ctx.state) {
      patch(host, ctx.state, { pendingId: null });
    }
  }
}

// Keep navigation from discarding an edit or moving away from an unresolved write.
export function businessNotificationNavigationBlocked(state: BusinessState) {
  return Boolean(
    state.loading ||
    state.decisionPending ||
    state.expensePending ||
    state.workPending ||
    state.supplierForm ||
    state.decisionForm ||
    state.reportForm ||
    state.expenseForm ||
    state.workForm ||
    state.expenseUncertain ||
    state.workUncertain ||
    state.notifications.pendingId,
  );
}

export function businessNotificationTarget(host: BusinessHost, id: string) {
  const ctx = context(host);
  if (
    !ctx ||
    !ctx.state.open ||
    ctx.state.loading ||
    ctx.state.error ||
    businessNotificationNavigationBlocked(host.business)
  ) {
    return null;
  }
  const record = ctx.state.records?.find((entry) => entry.id === id);
  return record ? { itemId: record.itemId, current: ctx.current } : null;
}
