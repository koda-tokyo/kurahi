import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GuardianConfig } from "../config/types.guardian.js";
import type { FileScanner } from "../security/scanner.js";
import type { LinkedCasePlan } from "../workitems/links.js";
import type { Actor, DepartmentId, WorkItem } from "../workitems/types.js";
import { attachLinkedStep, createLinkedCase } from "../workitems/links-store.js";
import { insertWorkItem, mutateWorkItem, workItemDir } from "../workitems/store.js";
import { isEngineTool, runEngineTool, runEngineToolAsync } from "./engine-tools.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-engine-linked-"));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const clerk: Actor = { id: "device:clerk0000001", kind: "person" };
const now = new Date("2026-10-26T01:00:00Z");
const queues: Record<string, DepartmentId> = { "hr-requests": "hr", "it-desk": "it" };
const departmentOf = (q: string) => queues[q];
let seq = 0;

const plan: LinkedCasePlan = {
  steps: [
    { key: "prepare", department: "hr", title: { en: "Prepare" }, dependsOn: [] },
    { key: "account", department: "it", title: { en: "Account" }, dependsOn: ["prepare"] },
  ],
};

function makeItem(projectId: string, opts: { queue?: string; owned?: boolean } = {}): string {
  const id = `weng${String(++seq).padStart(9, "0")}`;
  insertWorkItem(
    {
      id,
      projectId,
      queue: opts.queue ?? "hr-requests",
      status: "new",
      revision: 1,
      createdBy: clerk.id,
      assignee: opts.owned ? { kind: "person", id: clerk.id } : null,
      history: [],
    } as unknown as WorkItem,
    home,
  );
  return id;
}

function setStatus(projectId: string, id: string, status: WorkItem["status"]): void {
  mutateWorkItem(projectId, id, undefined, (cur) => ({ ...cur, status }), home);
}

/** A linked case whose first step's child is attached. */
function caseWithChild(projectId: string, owned: boolean): { parent: string; child: string } {
  const parent = makeItem(projectId, { owned });
  createLinkedCase(projectId, parent, plan, clerk, now, home);
  const child = makeItem(projectId);
  attachLinkedStep(projectId, parent, "prepare", child, departmentOf, clerk, now, home);
  return { parent, child };
}

function facts(projectId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of runEngineTool("workitems_linked", {}, { projectId, home }).split("\n")) {
    const m = /^fact ([^=]+)=(.*)$/.exec(line);
    if (m) {
      out[m[1]] = m[2];
    } else {
      out.verdict = line;
    }
  }
  return out;
}

describe("workitems_linked engine check", () => {
  it("is OK when open linked cases are only progressing", () => {
    const p = "pengok00001";
    const parent = makeItem(p);
    createLinkedCase(p, parent, plan, clerk, now, home);
    caseWithChild(p, true);
    makeItem(p); // an item with no linked case is not counted
    const f = facts(p);
    expect(f.verdict).toMatch(/^verdict OK /);
    expect(f.linkedCases).toBe("2");
    expect(f.readySteps).toBe("1");
    expect(f.stuck).toBe("0");
  });

  it("escalates blocked, missing and unreadable cases, counting the ones nobody owns", () => {
    const p = "pengbad0001";
    const cancelled = caseWithChild(p, false);
    setStatus(p, cancelled.child, "cancelled");
    const vanished = caseWithChild(p, true);
    fs.rmSync(workItemDir(p, vanished.child, home), { recursive: true, force: true });
    const corrupt = caseWithChild(p, false);
    fs.writeFileSync(path.join(workItemDir(p, corrupt.parent, home), "linked-case.json"), "{");

    const f = facts(p);
    expect(f.verdict).toBe("verdict ESCALATE 3 open linked case(s) stuck (2 with no assignee)");
    expect(f.linkedCases).toBe("3");
    expect(f.blocked).toBe("2");
    expect(f.missing).toBe("1");
    expect(f.unreadable).toBe("1");
    expect(f.unowned).toBe("2");
    expect(f.stuckIds.split(",").toSorted()).toEqual(
      [cancelled.parent, vanished.parent, corrupt.parent].toSorted(),
    );
  });

  it("skips closed parents and reads only the run's own Project", () => {
    const p = "pengdone001";
    const closed = caseWithChild(p, false);
    setStatus(p, closed.child, "cancelled");
    setStatus(p, closed.parent, "done");
    const f = facts(p);
    expect(f.verdict).toMatch(/^verdict OK /);
    expect(f.linkedCases).toBe("0");
    // The stuck cases of the other tests' Projects are not seen here.
    expect(facts("pengempty01").linkedCases).toBe("0");
  });

  it("reports a store it cannot list as unavailable, never as an empty OK", () => {
    const p = "pengnodir01";
    const root = path.dirname(workItemDir(p, "weng000000001", home));
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.writeFileSync(root, "not a directory");
    const f = facts(p);
    expect(f.verdict).toBe("verdict ESCALATE work items unavailable (ENOTDIR)");
    expect(f.available).toBe("false");
    expect(f.linkedCases).toBeUndefined();
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "reports an unreadable store as unavailable",
    () => {
      const p = "pengnoperm1";
      caseWithChild(p, true);
      const root = path.dirname(workItemDir(p, "weng000000001", home));
      fs.chmodSync(root, 0o000);
      try {
        expect(facts(p).verdict).toBe("verdict ESCALATE work items unavailable (EACCES)");
      } finally {
        fs.chmodSync(root, 0o755);
      }
    },
  );

  it("escalates when a work item cannot be read, since it may hide a stuck case", () => {
    const p = "pengitem001";
    caseWithChild(p, true);
    const broken = makeItem(p);
    fs.writeFileSync(path.join(workItemDir(p, broken, home), "item.json"), "{");
    const f = facts(p);
    expect(f.verdict).toBe("verdict ESCALATE 1 work item(s) unreadable; linked cases unknown");
    expect(f.stuck).toBe("0");
    expect(f.unreadableItems).toBe("1");
    expect(f.unreadableItemIds).toBe(broken);
  });

  it("lists no titles or content, only ids", () => {
    const p = "pengpriv001";
    const c = caseWithChild(p, false);
    setStatus(p, c.child, "cancelled");
    const text = runEngineTool("workitems_linked", {}, { projectId: p, home });
    expect(text).not.toMatch(/Prepare|Account/);
  });
});

function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^fact ([^=]+)=(.*)$/.exec(line);
    if (m) {
      out[m[1]] = m[2];
    } else {
      out.verdict = line;
    }
  }
  return out;
}

describe("guardian engine checks", () => {
  const gdir = (name: string) => {
    const d = path.join(home, "guardian-cases", name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const run = async (name: string, guardian: GuardianConfig, extra: object = {}) =>
    parse(await runEngineToolAsync(name, {}, { projectId: "pguard", home, guardian, ...extra }));

  it("all seven are engine checks and need the async runner", () => {
    for (const n of [
      "guardian_backup",
      "guardian_restore_test",
      "guardian_secrets",
      "guardian_ports",
      "guardian_integrity",
      "guardian_credentials",
      "guardian_scan",
    ]) {
      expect(isEngineTool(n)).toBe(true);
    }
    expect(() => runEngineTool("guardian_backup", {}, { projectId: "pguard" })).toThrow(
      /asynchronous/,
    );
  });

  it("guardian_backup: OK when fresh, ESCALATE when nothing is configured", async () => {
    const bk = gdir("bk");
    fs.writeFileSync(path.join(bk, "db.dump"), "x");
    const ok = await run("guardian_backup", { posture: { backups: [{ path: bk }] } });
    expect(ok.verdict).toBe("verdict OK every backup is fresh");
    expect(ok.findings).toBe("0");
    const none = await run("guardian_backup", {});
    expect(none.verdict).toMatch(/^verdict ESCALATE 1 finding\(s\): guardian.posture.backups/);
    expect(none.finding1).toMatch(/no backup paths/);
  });

  it("guardian_restore_test restores one file", async () => {
    const bk = gdir("rs");
    fs.writeFileSync(path.join(bk, "a.txt"), "data");
    const r = await run("guardian_restore_test", {
      posture: { backups: [{ path: bk, restoreTest: true }] },
    });
    expect(r.verdict).toBe("verdict OK every test restore matched");
    expect(r.restored).toBe("1");
  });

  it("guardian_secrets reports path:line and detector, never the value", async () => {
    const d = gdir("sec");
    const token = `xoxb-${"1234567890".repeat(2)}`;
    fs.writeFileSync(path.join(d, "slack.txt"), `token ${token}\n`);
    const text = await runEngineToolAsync(
      "guardian_secrets",
      {},
      { projectId: "pguard", guardian: { posture: { secretScanRoots: [d] } } },
    );
    expect(text).not.toContain(token);
    const f = parse(text);
    expect(f.verdict).toMatch(/^verdict ESCALATE/);
    expect(f.finding1).toBe(`${path.join(d, "slack.txt")}:1 possible secret (slack-token)`);
  });

  it("guardian_ports escalates without allowedPorts", async () => {
    const r = await run("guardian_ports", {});
    expect(r.verdict).toMatch(/^verdict ESCALATE/);
  });

  it("guardian_integrity and guardian_credentials print the protocol", async () => {
    for (const n of ["guardian_integrity", "guardian_credentials"]) {
      const f = await run(n, {});
      expect(f.verdict).toMatch(/^verdict (OK|ESCALATE) /);
      expect(f.findings).toMatch(/^\d+$/);
    }
  });

  it("guardian_scan: OK when clean, ESCALATE with hashes when infected, fails closed with no engine", async () => {
    const share = gdir("share");
    fs.writeFileSync(path.join(share, "ok.txt"), "fine");
    const scanner: FileScanner = {
      name: "clamav",
      scan: async (file) => {
        const bad = fs.readFileSync(file, "utf8").includes("EICAR");
        return {
          verdict: bad ? "infected" : "clean",
          scanner: "clamav",
          signature: bad ? "Test.EICAR" : null,
          detail: null,
          ms: 0,
        };
      },
    };
    const clean = await run("guardian_scan", { shares: [share] }, { scanner });
    expect(clean.verdict).toBe("verdict OK 1 file(s) scanned clean, 0 unchanged");
    fs.writeFileSync(path.join(share, "bad.exe"), "EICAR");
    const hit = await run("guardian_scan", { shares: [share] }, { scanner });
    expect(hit.verdict).toMatch(/^verdict ESCALATE 1 infected file\(s\), copies in /);
    expect(hit.skipped).toBe("1");
    expect(hit.infected1Sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(hit.infected1Signature).toBe("Test.EICAR");
    expect(hit.infected1Quarantine).not.toContain(share);
    expect(Object.values(hit).join(" ")).not.toContain("bad.exe");
    const noEngine = await run("guardian_scan", { shares: [share], scan: { engine: "none" } });
    expect(noEngine.verdict).toMatch(/^verdict ESCALATE 1 error\(s\): no malware scanner/);
  });

  it("a disabled Guardian is ESCALATE, never a pass", async () => {
    const f = await run("guardian_backup", { enabled: false });
    expect(f.verdict).toBe("verdict ESCALATE Guardian is disabled (guardian.enabled)");
  });
});
