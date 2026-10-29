import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkitemsNotificationsListResult } from "../../../../packages/client/src/generated/types";
import { emptyBusiness } from "../controllers/business";
import { businessNotificationsEn, businessNotificationsJa } from "../i18n/business-notifications";
import {
  renderBusinessNotifications,
  type BusinessNotificationsViewState,
} from "./business-notifications";

type Notice = WorkitemsNotificationsListResult["notifications"][number];
const reasons: Notice["reason"][] = [
  "awaiting_you",
  "delegated_to_you",
  "escalated_to_you",
  "delegation_withdrawn",
  "decided",
  "linked_step_ready",
  "linked_case_complete",
  "linked_case_blocked",
];
function notice(id = "notice-1", reason: Notice["reason"] = "awaiting_you"): Notice {
  return {
    id,
    principal: "secret-principal",
    itemId: `item-${id}`,
    reason,
    revision: 1,
    childId: "hidden-child",
    stepKey: "approve",
    createdAt: "2026-10-26T06:00:00Z",
    readAt: null,
  };
}
function mount(
  options: {
    records?: Notice[] | null;
    connected?: boolean;
    projectId?: string;
    loading?: boolean;
    error?: boolean;
    open?: boolean;
    pendingId?: string | null;
    markError?: boolean;
    locale?: string;
    visibleCount?: number;
  } = {},
) {
  const root = document.createElement("div");
  document.body.append(root);
  const state: BusinessNotificationsViewState = {
    business: {
      ...emptyBusiness(),
      projectId: options.projectId ?? "project-a",
      notifications: {
        open: options.open ?? true,
        visibleCount: options.visibleCount ?? 50,
        loading: options.loading ?? false,
        error: options.error ?? false,
        records: options.records === undefined ? [notice()] : options.records,
        pendingId: options.pendingId ?? null,
        markError: options.markError ?? false,
      },
    },
    connected: options.connected ?? true,
    locale: options.locale ?? "en",
    toggleBusinessNotifications: vi.fn(),
    refreshBusinessNotifications: vi.fn(),
    showMoreBusinessNotifications: vi.fn(),
    markBusinessNotificationRead: vi.fn(),
    openBusinessNotification: vi.fn(),
  };
  render(renderBusinessNotifications(state, "project-a"), root);
  return { root, state };
}
afterEach(() => {
  document.body.innerHTML = "";
});

describe("business notifications", () => {
  it.each(["en", "ja"])("renders all eight reasons and guidance in %s", (locale) => {
    const { root } = mount({
      locale,
      records: reasons.map((reason, i) => notice(String(i), reason)),
    });
    const catalogue = locale === "ja" ? businessNotificationsJa : businessNotificationsEn;
    for (const reason of reasons) {
      expect(root.textContent).toContain(catalogue[`business.notifications.reason.${reason}`]);
    }
    expect(root.textContent).toContain(catalogue["business.notifications.scope"]);
    expect(root.textContent).toContain("item-0");
    expect(root.textContent).toContain("approve");
    expect(root.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-26T06:00:00Z");
    expect(root.textContent).not.toContain("secret-principal");
    expect(root.textContent).not.toContain("hidden-child");
  });
  it("opens the parent item separately from marking a notification read", () => {
    const { root, state } = mount();
    root.querySelector<HTMLButtonElement>("[data-notification-open]")!.click();
    expect(state.openBusinessNotification).toHaveBeenCalledExactlyOnceWith("notice-1");
    expect(state.markBusinessNotificationRead).not.toHaveBeenCalled();
  });
  it("only marks read on an explicit row action", () => {
    const { root, state } = mount();
    expect(state.markBusinessNotificationRead).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>("[aria-expanded]")!.click();
    expect(state.toggleBusinessNotifications).toHaveBeenCalledOnce();
    expect(state.markBusinessNotificationRead).not.toHaveBeenCalled();
    const refresh = [...root.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Refresh notifications"),
    )!;
    refresh.click();
    expect(state.refreshBusinessNotifications).toHaveBeenCalledOnce();
    root.querySelector<HTMLButtonElement>("[data-notification-mark]")!.click();
    expect(state.markBusinessNotificationRead).toHaveBeenCalledExactlyOnceWith("notice-1");
  });
  it("keeps the closed panel hidden and exposes its expansion state", () => {
    const { root } = mount({ open: false });
    expect(root.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector("[role=region]")).toBeNull();
  });
  it.each([{ connected: false }, { projectId: "other-project" }])(
    "hides stale rows and unread count for %j",
    (options) => {
      const { root } = mount(options);
      expect(root.querySelector("[data-notification-id]")).toBeNull();
      expect(root.querySelector("[data-notifications-count]")).toBeNull();
      expect(root.textContent).not.toContain("item-notice-1");
      expect(root.textContent).not.toContain("No notifications for this Project.");
    },
  );
  it.each(["en", "ja"])(
    "keeps previous rows visible with truthful refresh state and disabled actions in %s",
    (locale) => {
      for (const options of [{ loading: true }, { error: true }]) {
        const { root, state } = mount({ ...options, locale });
        expect(root.querySelectorAll("[data-notification-id]")).toHaveLength(1);
        expect(root.querySelector("[data-notifications-count]")).toBeNull();
        const catalogue = locale === "ja" ? businessNotificationsJa : businessNotificationsEn;
        expect(root.textContent).toContain(
          catalogue[
            options.loading
              ? "business.notifications.loading"
              : "business.notifications.refreshError"
          ],
        );
        for (const button of root.querySelectorAll<HTMLButtonElement>(
          "[data-notification-open], [data-notification-mark]",
        )) {
          expect(button.disabled).toBe(true);
          button.click();
        }
        expect(state.openBusinessNotification).not.toHaveBeenCalled();
        expect(state.markBusinessNotificationRead).not.toHaveBeenCalled();
      }
    },
  );

  it("distinguishes confirmed empty from unavailable and loading", () => {
    expect(mount({ records: [] }).root.textContent).toContain("No notifications for this Project.");
    expect(mount({ records: null }).root.textContent).toContain("Notifications are unavailable.");
    expect(mount({ loading: true }).root.textContent).toContain("Loading notifications…");
  });
  it("disables all unread actions while a write is pending and omits read actions", () => {
    const records = [
      notice("one"),
      notice("two"),
      { ...notice("read"), readAt: "2026-10-26T07:00:00Z" },
    ];
    const { root, state } = mount({ records, pendingId: "one" });
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-notification-mark]")];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      button.click();
    }
    expect(state.markBusinessNotificationRead).not.toHaveBeenCalled();
    expect(root.querySelector("[data-notification-id=read]")?.textContent).toContain("Read");
    expect(root.querySelector("[data-notifications-count]")?.textContent).toContain("2 unread");
  });
  it("shows a generic write error without exposing raw details", () => {
    expect(mount({ markError: true }).root.textContent).toContain(
      "The read status could not be confirmed.",
    );
  });
  it("limits rows to latest 50 but counts all fetched unread records", () => {
    const records = Array.from({ length: 55 }, (_, index) => ({
      ...notice(String(index)),
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
    }));
    const { root, state } = mount({ records });
    expect(root.querySelectorAll("[data-notification-id]")).toHaveLength(50);
    expect(root.querySelector("[data-notification-id]")?.getAttribute("data-notification-id")).toBe(
      "54",
    );
    expect(root.querySelector('[data-notification-id="0"]')).toBeNull();
    expect(root.textContent).toContain("Showing 50 of 55 retained notifications");
    expect(root.querySelector("[data-notifications-count]")?.textContent).toContain("55 unread");
    expect(records[0].id).toBe("0");
    const more = root.querySelector<HTMLButtonElement>("[data-notifications-more]")!;
    more.focus();
    more.click();
    expect(state.showMoreBusinessNotifications).toHaveBeenCalledOnce();
    state.business.notifications.visibleCount = 55;
    render(renderBusinessNotifications(state, "project-a"), root);
    expect(root.querySelectorAll("[data-notification-id]")).toHaveLength(55);
    expect(root.querySelector('[data-notification-id="0"]')).not.toBeNull();
    expect(root.querySelector("[data-notifications-more]")).toBe(more);
    expect(more.disabled).toBe(true);
    expect(root.textContent).toContain("Showing 55 of 55 retained notifications");
  });
  it("sorts timestamps by instant even when offsets differ", () => {
    const records = [
      { ...notice("older"), createdAt: "2026-10-26T10:00:00+09:00" },
      { ...notice("newer"), createdAt: "2026-10-26T03:00:00Z" },
    ];
    const { root } = mount({ records });
    expect(root.querySelector("[data-notification-id]")?.getAttribute("data-notification-id")).toBe(
      "newer",
    );
  });
  it("keeps older unread notices reachable when newer read notices fill the display", () => {
    const records: Notice[] = Array.from({ length: 50 }, (_, index) => ({
      ...notice(String(index)),
      readAt: "2026-10-26T07:00:00Z",
    }));
    records.push({ ...notice("older-unread"), createdAt: "2026-10-01T00:00:00Z" });
    const { root } = mount({ records });
    expect(root.querySelector("[data-notification-id]")?.getAttribute("data-notification-id")).toBe(
      "older-unread",
    );
    expect(root.querySelector('[data-notification-mark="older-unread"]')).not.toBeNull();
  });
  it("disables the toggle and refresh when disconnected", () => {
    const { root, state } = mount({ connected: false });
    for (const button of root.querySelectorAll<HTMLButtonElement>("button")) {
      expect(button.disabled).toBe(true);
      button.click();
    }
    expect(state.toggleBusinessNotifications).not.toHaveBeenCalled();
    expect(state.refreshBusinessNotifications).not.toHaveBeenCalled();
  });
  it("renders untrusted IDs as text", () => {
    const { root } = mount({
      records: [
        { ...notice(), itemId: "<img src=x onerror=alert(1)>", stepKey: "<script>bad</script>" },
      ],
    });
    expect(root.querySelector("img, script")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
