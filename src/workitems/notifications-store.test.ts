import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "../projects/types.js";
import type { NotificationRecipient } from "./notify.js";
import { flushAudit } from "../audit/audit-log.js";
import { createProject, projectDataDir } from "../projects/store.js";
import {
  NOTIFICATIONS_KEPT,
  listNotifications,
  markNotificationRead,
  recordNotifications,
} from "./notifications-store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-notif-store-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

const alice = "device:alice000001";
const bob = "device:bob00000001";
const T0 = new Date("2026-11-02T00:00:00Z");
let project: Project;
let n = 0;
const item = (revision = 1) => ({
  projectId: project.id,
  id: `wnotify${String(++n).padStart(6, "0")}`,
  revision,
});
const to = (principal: string, reason: NotificationRecipient["reason"] = "awaiting_you") => ({
  principal,
  reason,
});

beforeAll(() => {
  const folder = path.join(root, "proj");
  fs.mkdirSync(folder, { recursive: true });
  project = createProject({ name: "Notifications", folder }, { createdBy: alice, template: null });
});

afterAll(async () => {
  await flushAudit();
  for (const [k, v] of [
    ["KOLO_HOME", saved.home],
    ["KOLO_STATE_DIR", saved.state],
  ] as const) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("work item notification records", () => {
  it("records one per recipient with ids only, and replaying the same write adds nothing", () => {
    const it1 = item(3);
    const added = recordNotifications(it1, [to(alice), to(bob, "decided")], T0);
    expect(added.map((r) => [r.principal, r.reason, r.revision, r.readAt])).toEqual([
      [alice, "awaiting_you", 3, null],
      [bob, "decided", 3, null],
    ]);
    expect(Object.keys(added[0]).toSorted()).toEqual(
      ["createdAt", "id", "itemId", "principal", "readAt", "reason", "revision"].toSorted(),
    );
    expect(recordNotifications(it1, [to(alice), to(bob, "decided")], T0)).toEqual([]);
    expect(listNotifications(project.id, alice).filter((r) => r.itemId === it1.id)).toHaveLength(1);
  });

  it("keeps a new record for a later revision or a different reason on the same item", () => {
    const it1 = item(1);
    recordNotifications(it1, [to(alice, "delegated_to_you")], T0);
    recordNotifications({ ...it1, revision: 2 }, [to(alice, "delegation_withdrawn")], T0);
    const mine = listNotifications(project.id, alice).filter((r) => r.itemId === it1.id);
    expect(mine.map((r) => r.reason)).toEqual(["delegation_withdrawn", "delegated_to_you"]);
  });

  it("lists only the principal's own records, filtered by current visibility and unread", () => {
    const hidden = item();
    const shown = item();
    recordNotifications(hidden, [to(bob)], T0);
    const [rec] = recordNotifications(shown, [to(bob)], T0);
    const visible = (id: string) => id !== hidden.id;
    expect(listNotifications(project.id, bob, { visible }).map((r) => r.itemId)).not.toContain(
      hidden.id,
    );
    markNotificationRead(project.id, bob, rec.id, T0);
    expect(listNotifications(project.id, bob, { unreadOnly: true }).map((r) => r.id)).not.toContain(
      rec.id,
    );
    expect(listNotifications(project.id, "device:nobody00001")).toEqual([]);
  });

  it("marks read only for the owning principal, and keeps the first read time", () => {
    const [rec] = recordNotifications(item(), [to(alice)], T0);
    expect(() => markNotificationRead(project.id, bob, rec.id, T0)).toThrow(
      expect.objectContaining({ code: "notification_not_found" }),
    );
    expect(() => markNotificationRead(project.id, alice, "../etc", T0)).toThrow(
      expect.objectContaining({ code: "notification_not_found" }),
    );
    const later = new Date(T0.getTime() + 60_000);
    expect(markNotificationRead(project.id, alice, rec.id, T0).readAt).toBe(T0.toISOString());
    expect(markNotificationRead(project.id, alice, rec.id, later).readAt).toBe(T0.toISOString());
  });

  it("trims read records before unread ones once the cap is reached", () => {
    const carol = "device:carol00001";
    const first = recordNotifications(item(), [to(carol)], T0)[0];
    const read = recordNotifications(item(), [to(carol)], T0)[0];
    markNotificationRead(project.id, carol, read.id, T0);
    for (let i = 0; i < NOTIFICATIONS_KEPT - 1; i++) {
      recordNotifications(item(), [to(carol)], T0);
    }
    const ids = listNotifications(project.id, carol).map((r) => r.id);
    expect(ids).toHaveLength(NOTIFICATIONS_KEPT);
    expect(ids).toContain(first.id);
    expect(ids).not.toContain(read.id);
  });

  it("stores a case's blocked notice and a step's ready notice once, even after both are trimmed", () => {
    const erin = "device:erin000001";
    const parent = item();
    const blocked = recordNotifications(
      parent,
      [to(erin, "linked_case_blocked")],
      T0,
      undefined,
      "wchild1",
    )[0];
    const ready = recordNotifications(
      parent,
      [to(erin, "linked_step_ready")],
      T0,
      undefined,
      "wchild1",
      "b",
    )[0];
    markNotificationRead(project.id, erin, blocked.id, T0);
    markNotificationRead(project.id, erin, ready.id, T0);
    for (let i = 0; i < NOTIFICATIONS_KEPT; i++) {
      recordNotifications(item(), [to(erin)], T0);
    }
    const ids = listNotifications(project.id, erin).map((r) => r.id);
    expect(ids).not.toContain(blocked.id);
    expect(ids).not.toContain(ready.id);
    const again = { ...parent, revision: 3 };
    expect(
      recordNotifications(again, [to(erin, "linked_case_blocked")], T0, undefined, "wchild2"),
    ).toEqual([]);
    expect(
      recordNotifications(again, [to(erin, "linked_step_ready")], T0, undefined, "wchild2", "b"),
    ).toEqual([]);
    // Another step of the same case still opens.
    expect(
      recordNotifications(again, [to(erin, "linked_step_ready")], T0, undefined, "wchild2", "c"),
    ).toHaveLength(1);
  });

  it.each([
    ["was stored before the once file existed", "legacy"],
    ["had its once write fail", "failed"],
  ])("keeps a once-only notice that %s once after it is trimmed", (_n, how) => {
    const gina = `device:gina${String(++n).padStart(6, "0")}`;
    const parent = item();
    const dir = path.join(projectDataDir(project.id), "notifications");
    const onceFiles = () => fs.readdirSync(dir).filter((f) => f.endsWith(".once.json"));
    const before = new Set(onceFiles());
    const store = () =>
      recordNotifications(parent, [to(gina, "linked_case_blocked")], T0, undefined, "wchild1");
    if (how === "failed") {
      const rename = fs.renameSync;
      fs.renameSync = ((from, dest) => {
        if (String(dest).endsWith(".once.json")) {
          throw new Error("injected once write failure");
        }
        return rename(from, dest);
      }) as typeof fs.renameSync;
      try {
        expect(store).toThrow("injected once write failure");
      } finally {
        fs.renameSync = rename;
      }
    } else {
      store();
    }
    // Either way the inbox holds the notice and no once file names it.
    for (const f of onceFiles().filter((f) => !before.has(f))) {
      fs.rmSync(path.join(dir, f));
    }
    const original = listNotifications(project.id, gina);
    expect(original).toHaveLength(1);
    for (let i = 0; i < NOTIFICATIONS_KEPT; i++) {
      recordNotifications(item(), [to(gina)], T0);
    }
    expect(listNotifications(project.id, gina).map((r) => r.id)).not.toContain(original[0].id);
    expect(
      recordNotifications(
        { ...parent, revision: 3 },
        [to(gina, "linked_case_blocked")],
        T0,
        undefined,
        "wchild2",
      ),
    ).toEqual([]);
  });

  it.each([
    ["not JSON", "{"],
    ["a non-string key", "[1]"],
    ["an empty key", '[""]'],
  ])("refuses a once file holding %s instead of storing a duplicate past it", (_n, raw) => {
    const frank = `device:frank${String(++n).padStart(5, "0")}`;
    const parent = item();
    const dir = path.join(projectDataDir(project.id), "notifications");
    const onceFiles = () => fs.readdirSync(dir).filter((f) => f.endsWith(".once.json"));
    const before = new Set(onceFiles());
    recordNotifications(parent, [to(frank, "linked_case_blocked")], T0, undefined, "wchild1");
    const mine = onceFiles().filter((f) => !before.has(f));
    expect(mine).toHaveLength(1);
    fs.writeFileSync(path.join(dir, mine[0]), raw);
    const stored = listNotifications(project.id, frank).length;
    const again = { ...parent, revision: 3 };
    expect(() =>
      recordNotifications(again, [to(frank, "linked_case_blocked")], T0, undefined, "wchild2"),
    ).toThrow();
    expect(listNotifications(project.id, frank)).toHaveLength(stored);
    // Reasons that may repeat never read the once file, and other principals are unaffected.
    expect(recordNotifications(item(), [to(frank)], T0)).toHaveLength(1);
    expect(
      recordNotifications(again, [to(bob, "linked_case_blocked")], T0, undefined, "wchild2"),
    ).toHaveLength(1);
  });

  it("refuses a file that names another principal instead of showing its records", () => {
    const dave = "device:dave000001";
    recordNotifications(item(), [to(dave)], T0);
    const dir = path.join(projectDataDir(project.id), "notifications");
    for (const f of fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".once.json"))) {
      const recs = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (recs[0]?.principal === dave) {
        recs[0].principal = alice;
        fs.writeFileSync(path.join(dir, f), JSON.stringify(recs));
      }
    }
    expect(() => listNotifications(project.id, dave)).toThrow(/corrupt/);
  });

  it.each([
    ["missing readAt", (r: Record<string, unknown>) => delete r.readAt],
    ["readAt not a time", (r: Record<string, unknown>) => (r.readAt = "yesterday")],
    ["unknown reason", (r: Record<string, unknown>) => (r.reason = "fyi")],
    ["missing itemId", (r: Record<string, unknown>) => delete r.itemId],
    ["fractional revision", (r: Record<string, unknown>) => (r.revision = 1.5)],
    ["malformed id", (r: Record<string, unknown>) => (r.id = "x")],
    ["missing createdAt", (r: Record<string, unknown>) => delete r.createdAt],
    ["empty childId", (r: Record<string, unknown>) => (r.childId = "")],
    ["numeric stepKey", (r: Record<string, unknown>) => (r.stepKey = 3)],
    ["null record", (_r: Record<string, unknown>, recs: unknown[]) => (recs[0] = null)],
  ])("refuses a file whose own record has %s instead of dropping it from unread", (_n, edit) => {
    const erin = `device:erin${String(++n).padStart(6, "0")}`;
    recordNotifications(item(), [to(erin)], T0);
    const dir = path.join(projectDataDir(project.id), "notifications");
    let edited = false;
    for (const f of fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".once.json"))) {
      const recs = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (recs[0]?.principal === erin) {
        edit(recs[0], recs);
        fs.writeFileSync(path.join(dir, f), JSON.stringify(recs));
        edited = true;
      }
    }
    expect(edited).toBe(true);
    expect(() => listNotifications(project.id, erin, { unreadOnly: true })).toThrow(/corrupt/);
    // A later write to the same inbox must not paper over the bad record either.
    expect(() => recordNotifications(item(), [to(erin)], T0)).toThrow(/corrupt/);
  });
});
