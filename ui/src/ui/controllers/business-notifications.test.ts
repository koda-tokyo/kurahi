import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway";
import type { BusinessHost } from "./business";
import { emptyBusiness } from "./business";
import {
  emptyBusinessNotifications,
  loadBusinessNotifications,
  showMoreBusinessNotifications,
  toggleBusinessNotifications,
  markBusinessNotificationRead,
} from "./business-notifications";
import { DEFAULT_PROJECTS_STATE } from "./projects";

const record = () => ({
  id: "n1",
  principal: "alice",
  itemId: "i1",
  reason: "awaiting_you" as const,
  revision: 1,
  createdAt: "2026-10-26T06:00:00Z",
  readAt: null as string | null,
});
const result = () => ({ notifications: [record()] });
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const request = vi.fn().mockResolvedValue(result());
  const host: BusinessHost = {
    business: { ...emptyBusiness(), projectId: "p1", notifications: emptyBusinessNotifications() },
    connected: true,
    tab: "projects",
    client: { request } as unknown as GatewayBrowserClient,
    projects: { ...DEFAULT_PROJECTS_STATE, selectedId: "p1", view: "business" },
  };
  return { host, request };
}

describe("business notifications", () => {
  it("lists readable records on opening without a principal selector or automatic write", async () => {
    const { host, request } = fixture();
    await toggleBusinessNotifications(host);
    expect(host.business.notifications).toMatchObject({
      open: true,
      loading: false,
      records: [record()],
    });
    await toggleBusinessNotifications(host);
    expect(request.mock.calls).toEqual([["workitems.notifications.list", { projectId: "p1" }]]);
  });

  it.each(["project", "reset", "client", "disconnected", "tab", "view"])(
    "discards responses after %s changes",
    async (kind) => {
      const { host, request } = fixture();
      const pending = deferred();
      request.mockReturnValueOnce(pending.promise);
      const task = loadBusinessNotifications(host);
      if (kind === "project") {
        host.projects.selectedId = "p2";
      }
      if (kind === "reset") {
        host.business.notifications = emptyBusinessNotifications();
      }
      if (kind === "client") {
        host.client = {} as GatewayBrowserClient;
      }
      if (kind === "disconnected") {
        host.connected = false;
      }
      if (kind === "tab") {
        host.tab = "chat";
      }
      if (kind === "view") {
        host.projects.view = "chat";
      }
      pending.resolve(result());
      await task;
      expect(host.business.notifications.records).toBeNull();
    },
  );

  it("rejects out-of-order loads and preserves loaded rows during refresh", async () => {
    const { host, request } = fixture();
    await toggleBusinessNotifications(host);
    const first = deferred();
    const second = deferred();
    request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = loadBusinessNotifications(host);
    const b = loadBusinessNotifications(host);
    expect(host.business.notifications).toMatchObject({
      records: [record()],
      loading: true,
      open: true,
    });
    second.resolve({ notifications: [] });
    await b;
    first.resolve(result());
    await a;
    expect(host.business.notifications.records).toEqual([]);
  });

  it.each(["project", "tab"])(
    "ignores a refresh response after leaving the loaded %s scope",
    async (kind) => {
      const { host, request } = fixture();
      await toggleBusinessNotifications(host);
      const pending = deferred();
      request.mockReturnValueOnce(pending.promise);
      const task = loadBusinessNotifications(host);
      if (kind === "project") {
        host.projects.selectedId = "p2";
        host.business = { ...emptyBusiness(), projectId: "p2" };
      } else {
        host.tab = "chat";
      }
      pending.resolve({ notifications: [{ ...record(), id: "late" }] });
      await task;
      expect(host.business.notifications.records).toEqual(kind === "project" ? null : [record()]);
    },
  );

  it.each([
    null,
    {},
    { notifications: null },
    { notifications: [record(), record()] },
    { notifications: [{ ...record(), reason: "secret" }] },
    { notifications: [{ ...record(), itemId: null }] },
    { notifications: [{ ...record(), createdAt: "invalid" }] },
    { notifications: [{ ...record(), readAt: 123 }] },
    { notifications: [{ ...record(), revision: 1.5 }] },
    { notifications: [{ ...record(), stepKey: {} }] },
  ])("fails closed on malformed lists (%j)", async (answer) => {
    const { host, request } = fixture();
    request.mockResolvedValue(answer);
    await loadBusinessNotifications(host);
    expect(host.business.notifications).toMatchObject({
      records: null,
      error: true,
      loading: false,
    });
  });

  it("marks only an explicit unread record, then reloads authoritative records", async () => {
    const { host, request } = fixture();
    await loadBusinessNotifications(host);
    const ack = deferred();
    const reload = deferred();
    request.mockReturnValueOnce(ack.promise).mockReturnValueOnce(reload.promise);
    const task = markBusinessNotificationRead(host, "n1");
    expect(host.business.notifications.records?.[0].readAt).toBeNull();
    expect(host.business.notifications.pendingId).toBe("n1");
    ack.resolve({ notification: { ...record(), readAt: "2026-10-26T06:01:00Z" } });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(host.business.notifications.records?.[0].readAt).toBe("2026-10-26T06:01:00Z");
    expect(host.business.notifications.loading).toBe(true);
    reload.resolve({ notifications: [] });
    await task;
    expect(host.business.notifications).toMatchObject({ records: [], pendingId: null });
    expect(request.mock.calls[1]).toEqual([
      "workitems.notifications.markRead",
      { projectId: "p1", id: "n1" },
    ]);
  });

  it.each(["refusal", "id", "item", "principal", "unread", "malformed"])(
    "keeps unread data and a generic error for %s acknowledgements",
    async (kind) => {
      const { host, request } = fixture();
      await loadBusinessNotifications(host);
      const notification = { ...record(), readAt: "2026-10-26T06:01:00Z" };
      if (kind === "id") {
        notification.id = "other";
      }
      if (kind === "item") {
        notification.itemId = "other";
      }
      if (kind === "principal") {
        notification.principal = "other";
      }
      if (kind === "refusal") {
        request.mockRejectedValueOnce(new Error("private server path"));
      } else {
        request.mockResolvedValueOnce(
          kind === "malformed" ? {} : { notification: kind === "unread" ? record() : notification },
        );
      }
      await markBusinessNotificationRead(host, "n1");
      expect(host.business.notifications).toMatchObject({
        markError: true,
        pendingId: null,
        records: [record()],
      });
      expect(request).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(host.business.notifications)).not.toContain("private");
    },
  );

  it("ignores unknown/read IDs and inactive projects", async () => {
    const { host, request } = fixture();
    await loadBusinessNotifications(host);
    await markBusinessNotificationRead(host, "unknown");
    host.business.notifications.records![0].readAt = "2026-10-26T06:01:00Z";
    await markBusinessNotificationRead(host, "n1");
    host.projects.selectedId = "p2";
    await loadBusinessNotifications(host);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["project", "client", "reset"])(
    "drops a write acknowledgement after %s changes",
    async (kind) => {
      const { host, request } = fixture();
      await loadBusinessNotifications(host);
      const ack = deferred();
      request.mockReturnValueOnce(ack.promise);
      const task = markBusinessNotificationRead(host, "n1");
      if (kind === "project") {
        host.projects.selectedId = "p2";
      }
      if (kind === "client") {
        host.client = {} as GatewayBrowserClient;
      }
      if (kind === "reset") {
        host.business.notifications = emptyBusinessNotifications();
      }
      ack.resolve({ notification: { ...record(), readAt: "2026-10-26T06:01:00Z" } });
      await task;
      expect(request).toHaveBeenCalledTimes(2);
      expect(host.business.notifications.records?.[0].readAt ?? null).toBeNull();
    },
  );

  it.each(["resolve", "reject", "reload resolve", "reload reject"])(
    "releases pending state when %s settles away from the projects tab",
    async (kind) => {
      const { host, request } = fixture();
      await loadBusinessNotifications(host);
      const ack = deferred();
      const reload = deferred();
      request.mockReturnValueOnce(ack.promise);
      if (kind.startsWith("reload")) {
        request.mockReturnValueOnce(reload.promise);
      }
      const task = markBusinessNotificationRead(host, "n1");
      if (kind.startsWith("reload")) {
        ack.resolve({ notification: { ...record(), readAt: "2026-10-26T06:01:00Z" } });
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
      }
      host.tab = "chat";
      const pending = kind.startsWith("reload") ? reload : ack;
      if (kind.endsWith("reject")) {
        pending.reject(new Error("private failure"));
      } else {
        pending.resolve(
          kind.startsWith("reload")
            ? { notifications: [] }
            : {
                notification: { ...record(), readAt: "2026-10-26T06:01:00Z" },
              },
        );
      }
      await task;
      expect(host.business.notifications).toMatchObject({ pendingId: null, markError: false });
      expect(host.business.notifications.records).toEqual(
        kind.startsWith("reload") ? [{ ...record(), readAt: "2026-10-26T06:01:00Z" }] : [record()],
      );
      host.tab = "projects";
      await loadBusinessNotifications(host);
      expect(host.business.notifications).toMatchObject({ loading: false, pendingId: null });
      const before = request.mock.calls.length;
      request.mockRejectedValueOnce(new Error("refused"));
      await markBusinessNotificationRead(host, "n1");
      expect(request).toHaveBeenCalledTimes(before + 1);
      expect(request.mock.calls[before][0]).toBe("workitems.notifications.markRead");
    },
  );

  it("keeps confirmed read status on reload failure and blocks stale actions until refresh", async () => {
    const { host, request } = fixture();
    request.mockResolvedValueOnce({ notifications: [record(), { ...record(), id: "n2" }] });
    await toggleBusinessNotifications(host);
    request
      .mockResolvedValueOnce({ notification: { ...record(), readAt: "2026-10-26T06:01:00Z" } })
      .mockRejectedValueOnce(new Error("reload failed"));
    await markBusinessNotificationRead(host, "n1");
    expect(host.business.notifications).toMatchObject({
      error: true,
      loading: false,
      pendingId: null,
      markError: false,
    });
    expect(host.business.notifications.records?.[0].readAt).toBe("2026-10-26T06:01:00Z");
    expect(host.business.notifications.records?.[1].readAt).toBeNull();
    await markBusinessNotificationRead(host, "n2");
    expect(request).toHaveBeenCalledTimes(3);
    request.mockResolvedValueOnce({ notifications: [] });
    await loadBusinessNotifications(host);
    expect(host.business.notifications).toMatchObject({ records: [], error: false });
  });

  it("reveals retained records in bounded batches without extra RPCs, preserving depth on reload", async () => {
    const { host, request } = fixture();
    const records = Array.from({ length: 125 }, (_, i) => ({ ...record(), id: `n${i}` }));
    request.mockResolvedValue({ notifications: records });
    await toggleBusinessNotifications(host);
    expect(host.business.notifications.visibleCount).toBe(50);
    showMoreBusinessNotifications(host);
    expect(host.business.notifications.visibleCount).toBe(100);
    showMoreBusinessNotifications(host);
    showMoreBusinessNotifications(host);
    expect(host.business.notifications.visibleCount).toBe(125);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce({
      notification: { ...records[0], readAt: "2026-10-26T06:01:00Z" },
    });
    await markBusinessNotificationRead(host, "n0");
    expect(host.business.notifications.visibleCount).toBe(125);
    host.business.notifications = emptyBusinessNotifications();
    expect(host.business.notifications.visibleCount).toBe(50);
  });

  it.each(["loading", "error", "closed", "project"])(
    "does not reveal more for %s state",
    (kind) => {
      const { host } = fixture();
      Object.assign(host.business.notifications, {
        open: true,
        records: Array.from({ length: 60 }, (_, i) => ({ ...record(), id: `n${i}` })),
      });
      if (kind === "loading") {
        host.business.notifications.loading = true;
      }
      if (kind === "error") {
        host.business.notifications.error = true;
      }
      if (kind === "closed") {
        host.business.notifications.open = false;
      }
      if (kind === "project") {
        host.projects.selectedId = "other";
      }
      showMoreBusinessNotifications(host);
      expect(host.business.notifications.visibleCount).toBe(50);
    },
  );

  it("serializes double clicks and unresolved writes across navigation reset", async () => {
    const { host, request } = fixture();
    await loadBusinessNotifications(host);
    const ack = deferred();
    request.mockReturnValueOnce(ack.promise);
    const task = markBusinessNotificationRead(host, "n1");
    await markBusinessNotificationRead(host, "n1");
    host.business.notifications = { ...emptyBusinessNotifications(), records: [record()] };
    await markBusinessNotificationRead(host, "n1");
    expect(request).toHaveBeenCalledTimes(2);
    ack.resolve({ notification: { ...record(), readAt: "2026-10-26T06:01:00Z" } });
    await task;
    expect(host.business.notifications).toMatchObject({
      records: [record()],
      pendingId: null,
      markError: false,
    });
    expect(request).toHaveBeenCalledTimes(2);
    request.mockRejectedValueOnce(new Error("refused"));
    await markBusinessNotificationRead(host, "n1");
    expect(request).toHaveBeenCalledTimes(3);
  });
});
