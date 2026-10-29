import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KoLoConfig } from "../config/config.js";
import type { Project } from "../projects/types.js";
import type { WorkItem } from "../workitems/types.js";
import { pruneAuditMonths } from "../audit/anchor.js";
import { appendAudit, flushAudit } from "../audit/audit-log.js";
import { verifyAuditChain } from "../audit/verify.js";
import { writeSealedBundle } from "../evidence/sealed-bundle.js";
import { verifyTombstone, listJobTombstones } from "../evidence/tombstone.js";
import { readZip, writeZip } from "../evidence/zip.js";
import { createProject } from "../projects/store.js";
import { listEvidenceBundles, verifyWorkItemEvidenceChain } from "../workitems/evidence.js";
import { applyTransition, createWorkItem } from "../workitems/lifecycle.js";
import { readWorkItem, workItemDir } from "../workitems/store.js";
import { executeSubjectRequest, findSubjectData } from "./dsr.js";
import { startExport, verifyGovernanceExport, buildExportArchive } from "./export.js";
import { createHold, releaseHold } from "./holds.js";
import {
  guardOutboundCall,
  PersonalDataBlockedError,
  wrapToolWithPersonalDataGuard,
} from "./outbound-guard.js";
import {
  effectiveRetention,
  GovernanceRefused,
  orgRetention,
  setProjectOverride,
} from "./policy.js";
import { runRetentionSweep } from "./sweeper.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-governance-"));
const home = path.join(root, "state");
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = home;
process.env.KOLO_STATE_DIR = home;

const DAY = 86_400_000;
const NOW = new Date("2027-06-01T00:00:00.000Z");
const OLD = new Date("2026-01-10T00:00:00.000Z");
const VALID_MY_NUMBER = "123456789018";

const person = { id: "person:hanako@example.co.jp", kind: "person" as const };

function cfg(retention: NonNullable<KoLoConfig["governance"]>["retention"]): KoLoConfig {
  return {
    governance: { retention, minimumRetentionDays: { audit: 30, evidence: 30 } },
  } as KoLoConfig;
}

function setOld(p: string, when: Date = OLD) {
  fs.utimesSync(p, when, when);
}

let projectA: Project;
let projectB: Project;

function closedItem(project: Project, title: string, at: Date = OLD): WorkItem {
  const item = createWorkItem(
    project,
    { queue: "general", title, source: { fields: { requester: "taro@example.com" } } },
    person,
    {
      now: at,
    },
  );
  applyTransition(
    project,
    item.id,
    undefined,
    (cur) => ({ next: cur, spec: { action: "start", actor: person, to: "drafting" } }),
    {
      now: new Date(at.getTime() + 1000),
    },
  );
  return applyTransition(
    project,
    item.id,
    undefined,
    (cur) => ({
      next: cur,
      spec: { action: "complete", actor: person, to: "done", comment: "済" },
    }),
    { now: new Date(at.getTime() + 2000) },
  );
}

function writeTranscript(agent: string, key: string, sessionId: string, text: string, when = OLD) {
  const dir = path.join(home, "agents", agent, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  const store = fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, "utf8")) : {};
  store[key] = { sessionId, updatedAt: when.getTime() };
  fs.writeFileSync(storePath, JSON.stringify(store));
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", id: sessionId, timestamp: when.toISOString() }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text }] },
      }),
    ].join("\n") + "\n",
  );
  setOld(file, when);
  return file;
}

function writeJobEvidence(jobId: string, sessionKey: string, when = OLD) {
  const ts = when.toISOString();
  writeSealedBundle(
    path.join(home, "evidence", jobId),
    { jobId, agent: "main", sessionKey, kind: "chat", status: "done", startedAt: ts, endedAt: ts },
    [
      {
        type: "job.start",
        ts,
        data: { sessionKey, projectId: sessionKey.includes("proj-") ? projectA.id : null },
      },
      { type: "job.end", ts, data: { status: "done" } },
    ],
  );
}

beforeAll(() => {
  fs.mkdirSync(home, { recursive: true });
  const fa = path.join(root, "client-a");
  const fb = path.join(root, "client-b");
  fs.mkdirSync(fa);
  fs.mkdirSync(fb);
  projectA = createProject({ name: "A", folder: fa, allowedAgents: [] }, { createdBy: "owner" });
  projectB = createProject({ name: "B", folder: fb, allowedAgents: [] }, { createdBy: "owner" });
});

afterAll(async () => {
  await flushAudit();
  process.env.KOLO_HOME = saved.home;
  process.env.KOLO_STATE_DIR = saved.state;
  if (saved.home === undefined) {
    delete process.env.KOLO_HOME;
  }
  if (saved.state === undefined) {
    delete process.env.KOLO_STATE_DIR;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("retention policy", () => {
  it("clamps evidence and audit to the minimum and refuses overrides below it", () => {
    const c = { retention: { audit: { keepDays: 10 }, evidence: { keepDays: 5 } } };
    const org = orgRetention(c);
    expect(org.audit.keepDays).toBe(365);
    expect(org.evidence.keepDays).toBe(365);
    expect(org.attachments.mode).toBe("delete");
    expect(() =>
      setProjectOverride(c, home, projectA.id, { retention: { evidence: { keepDays: 100 } } }, "p"),
    ).toThrowError(GovernanceRefused);
    try {
      setProjectOverride(c, home, projectA.id, { retention: { evidence: { keepDays: 100 } } }, "p");
    } catch (err) {
      expect((err as GovernanceRefused).code).toBe("retention_below_minimum");
    }
    expect(() =>
      setProjectOverride(c, home, projectA.id, { retention: { audit: { keepDays: 400 } } }, "p"),
    ).toThrow(/organisation-wide/);
    expect(() =>
      setProjectOverride(
        c,
        home,
        projectA.id,
        { retention: { attachments: { mode: "anonymize" } } },
        "p",
      ),
    ).toThrow(/cannot be anonymized/);
    setProjectOverride(
      c,
      home,
      projectB.id,
      { retention: { transcripts: { keepDays: 7, mode: "anonymize" } } },
      "p",
    );
    expect(effectiveRetention(c, home, projectB.id).transcripts).toEqual({
      keepDays: 7,
      mode: "anonymize",
    });
    expect(effectiveRetention(c, home, projectA.id).transcripts).toEqual({
      keepDays: null,
      mode: "delete",
    });
    setProjectOverride(c, home, projectB.id, {}, "p");
  });
});

describe("audit retention keeps the chain verifiable", () => {
  it("prunes whole months behind a signed anchor; tampering is detected", async () => {
    const dir = path.join(root, "audit-only");
    const stateDir = path.join(root, "audit-key");
    for (const ts of ["2025-01-05", "2025-01-20", "2025-02-03", "2025-03-01", "2025-03-02"]) {
      await appendAudit(
        { action: "t.x", outcome: "ok", source: "test", detail: { n: ts } },
        { dir, now: () => new Date(`${ts}T00:00:00Z`) },
      );
    }
    expect(verifyAuditChain(dir).ok).toBe(true);
    const pruned = pruneAuditMonths({ dir, stateDir, beforeMonth: "2025-03" });
    expect(pruned.months).toEqual(["2025-01", "2025-02"]);
    expect(pruned.entries).toBe(3);
    const v = verifyAuditChain(dir);
    expect(v.ok, JSON.stringify(v.firstBreak)).toBe(true);
    expect(v.anchor?.seq).toBe(3);
    // The newest month is never removed.
    expect(pruneAuditMonths({ dir, stateDir, beforeMonth: "2099-01" }).months).toEqual([]);
    // A forged anchor fails.
    const anchorFile = path.join(dir, "ANCHOR.json");
    const anchor = JSON.parse(fs.readFileSync(anchorFile, "utf8"));
    fs.writeFileSync(anchorFile, JSON.stringify({ ...anchor, seq: 2 }));
    expect(verifyAuditChain(dir).ok).toBe(false);
    fs.writeFileSync(anchorFile, JSON.stringify(anchor));
    expect(verifyAuditChain(dir).ok).toBe(true);
    // Removing history without an anchor is still a break.
    fs.rmSync(anchorFile);
    expect(verifyAuditChain(dir).firstBreak?.reason).toMatch(/genesis/);
  });
});

describe("retention sweeper", () => {
  it("deletes and anonymizes per class, skips held records and writes a signed manifest", async () => {
    const itemDelete = closedItem(projectA, "契約書の確認");
    const itemHeld = closedItem(projectA, "保留中の案件");
    const itemB = closedItem(projectB, "B社 稟議");
    const itemOpen = createWorkItem(projectA, { queue: "general", title: "未完了" }, person, {
      now: OLD,
    });
    const tA = writeTranscript("main", `agent:main:proj-${projectA.id}-c1`, "s-a", "見積の件");
    const tB = writeTranscript("main", `agent:main:proj-${projectB.id}-c2`, "s-b", "B の件");
    writeJobEvidence("job-old-a", `agent:main:proj-${projectA.id}-c1`);
    const attach = path.join(home, "projects", projectA.id, "attachments", "invoice.pdf");
    fs.mkdirSync(path.dirname(attach), { recursive: true });
    fs.writeFileSync(attach, "pdf");
    setOld(attach);
    const art = path.join(home, "artifacts", "aabcdefghijkl");
    fs.mkdirSync(art, { recursive: true });
    fs.writeFileSync(
      path.join(art, "meta.json"),
      JSON.stringify({
        id: "aabcdefghijkl",
        projectId: projectA.id,
        createdAt: OLD.toISOString(),
        updatedAt: OLD.toISOString(),
        versions: [],
      }),
    );
    const q = path.join(home, "memory-provenance", "main", "quarantine");
    fs.mkdirSync(q, { recursive: true });
    fs.writeFileSync(
      path.join(q, "0123456789abcdef.json"),
      JSON.stringify({
        id: "0123456789abcdef",
        createdAt: OLD.toISOString(),
        status: "rejected",
        decidedAt: OLD.toISOString(),
        op: { kind: "write", path: "/x", content: "secret plan" },
      }),
    );
    const cache = path.join(home, "connectors", "box", "cache", "f.json");
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, "{}");
    setOld(cache);

    const hold = createHold(
      home,
      { matterId: "M-1", reason: "litigation", scope: { workItemIds: [itemHeld.id] } },
      "person:legal",
    );
    setProjectOverride(
      { minimumRetentionDays: { evidence: 30 } },
      home,
      projectB.id,
      {
        retention: {
          workitems: { keepDays: 30, mode: "anonymize" },
          transcripts: { keepDays: 30, mode: "anonymize" },
        },
      },
      "person:legal",
    );
    const config = cfg({
      transcripts: { keepDays: 30 },
      workitems: { keepDays: 30 },
      evidence: { keepDays: 30 },
      attachments: { keepDays: 30 },
      outputs: { keepDays: 30 },
      memory: { keepDays: 30 },
      connectorCaches: { keepDays: 30 },
    });

    const dry = await runRetentionSweep({ home, config, now: NOW, dryRun: true });
    expect(dry.manifestId).toBeNull();
    expect(dry.classes.workitems.deleted).toBe(1);
    expect(fs.existsSync(tA)).toBe(true);

    const r = await runRetentionSweep({ home, config, now: NOW, by: "test" });
    expect(r.classes.workitems).toMatchObject({ deleted: 1, anonymized: 1, held: 1 });
    expect(r.classes.transcripts).toMatchObject({ deleted: 1, anonymized: 1 });
    expect(r.classes.attachments.deleted).toBe(1);
    expect(r.classes.outputs.deleted).toBe(1);
    expect(r.classes.memory.deleted).toBe(1);
    expect(r.classes.connectorCaches.deleted).toBe(1);
    // job-old-a + the closed items' transition bundles not under hold (2 items x 3 bundles).
    expect(r.classes.evidence.deleted).toBe(7);
    expect(r.classes.evidence.held).toBe(3);

    // workitems: deleted keeps evidence/ only, anonymized keeps structure, held untouched, open kept.
    expect(
      fs.existsSync(
        path.join(home, "projects", projectA.id, "workitems", itemDelete.id, "item.json"),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(home, "projects", projectA.id, "workitems", itemDelete.id, "deleted.json"),
      ),
    ).toBe(true);
    const anon = readWorkItem(projectB.id, itemB.id)!;
    expect(anon.title).toBe("[anonymized]");
    expect(anon.status).toBe("done");
    expect(anon.history).toHaveLength(itemB.history.length);
    expect(anon.createdBy).toMatch(/^anon:/);
    expect(JSON.stringify(anon)).not.toContain("taro@example.com");
    expect(readWorkItem(projectA.id, itemHeld.id)?.title).toBe("保留中の案件");
    expect(readWorkItem(projectA.id, itemOpen.id)?.title).toBe("未完了");
    // transcripts
    expect(fs.existsSync(tA)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(home, "agents/main/sessions/sessions.json"), "utf8")),
    ).not.toHaveProperty(`agent:main:proj-${projectA.id}-c1`);
    expect(fs.readFileSync(tB, "utf8")).not.toContain("B の件");
    expect(fs.readFileSync(tB, "utf8")).toContain('"role":"user"');
    // files
    expect(fs.existsSync(attach)).toBe(false);
    expect(fs.existsSync(art)).toBe(false);
    expect(fs.existsSync(cache)).toBe(false);
    // job evidence left a verifying tombstone
    const tombs = listJobTombstones(home);
    expect(tombs.map((t) => t.jobId)).toContain("job-old-a");
    expect(verifyTombstone(tombs.find((t) => t.jobId === "job-old-a")!).ok).toBe(true);
    // the deletion manifest is a signed evidence bundle with hashed ids, never names
    expect(r.manifestId).toMatch(/^gov-retention-/);
    const manifestDir = path.join(home, "evidence", r.manifestId!);
    const events = fs.readFileSync(path.join(manifestDir, "events.jsonl"), "utf8");
    expect(events).toContain('"class":"workitems"');
    expect(events).not.toContain(itemDelete.id);
    const { verifyEvidenceBundle } = await import("../evidence/verify.js");
    expect((await verifyEvidenceBundle(manifestDir)).ok).toBe(true);
    // Deletion manifests never expire.
    const again = await runRetentionSweep({
      home,
      config,
      now: new Date(NOW.getTime() + 400 * DAY),
    });
    expect(fs.existsSync(manifestDir)).toBe(true);
    expect(again.classes.workitems.held).toBe(1);
    releaseHold(home, hold.id, "matter closed", "person:legal");
  });

  it("evidence chain of a work item still verifies after bundles are tombstoned", async () => {
    const item = closedItem(projectA, "連鎖の確認");
    const before = await verifyWorkItemEvidenceChain(item);
    expect(before.chainOk).toBe(true);
    expect(before.bundles).toHaveLength(3);
    await runRetentionSweep({
      home,
      config: cfg({ evidence: { keepDays: 30 } }),
      now: NOW,
      classes: ["evidence"],
    });
    const after = await verifyWorkItemEvidenceChain(item);
    expect(after.chainOk, JSON.stringify(after.bundles)).toBe(true);
    expect(after.bundles.every((b) => b.tombstone)).toBe(true);
    expect(after.bundles.map((b) => b.root)).toEqual(before.bundles.map((b) => b.root));
    // A tampered tombstone breaks the chain.
    const [, second] = listEvidenceBundles(item);
    const file = path.join(
      home,
      "projects",
      projectA.id,
      "workitems",
      item.id,
      "evidence",
      second,
      "tombstone.json",
    );
    const t = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...t, root: "0".repeat(64) }));
    expect((await verifyWorkItemEvidenceChain(item)).chainOk).toBe(false);
    fs.writeFileSync(file, JSON.stringify(t));
    expect((await verifyWorkItemEvidenceChain(item)).chainOk).toBe(true);
  });
});

describe("eDiscovery export", () => {
  it("writes a self-verifying archive limited to the scope", async () => {
    const inA = closedItem(projectA, "輸出対象", new Date("2027-05-01T00:00:00Z"));
    const inB = closedItem(projectB, "対象外", new Date("2027-05-01T00:00:00Z"));
    const { status, done } = startExport(
      home,
      {
        reason: "court order",
        matterId: "M-2",
        scope: { projectIds: [projectA.id] },
        redact: false,
      },
      "person:legal",
    );
    expect(status.status).toBe("running");
    const finished = await done;
    expect(finished.status, finished.error ?? "").toBe("done");
    const zip = fs.readFileSync(path.join(home, "governance", "exports", `${status.id}.zip`));
    const v = await verifyGovernanceExport(zip);
    expect(v.ok, v.problems.join("; ")).toBe(true);
    const files = await readZip(zip);
    const names = [...files.keys()];
    expect(names).toContain(`workitems/${projectA.id}/${inA.id}/item.json`);
    expect(names.some((n) => n.includes(inB.id))).toBe(false);
    expect(names).toContain("verification.json");
    expect(names).toContain("audit/rows.jsonl");
    // Tampering with any file, or adding one, fails verification.
    const tampered = new Map(files);
    tampered.set(`workitems/${projectA.id}/${inA.id}/item.json`, Buffer.from("{}"));
    expect((await verifyGovernanceExport(await writeZip(tampered))).ok).toBe(false);
    const extra = new Map(files);
    extra.set("smuggled.txt", Buffer.from("x"));
    expect((await verifyGovernanceExport(await writeZip(extra))).ok).toBe(false);
  });

  it("redacts personal identifiers when asked", async () => {
    const item = createWorkItem(
      projectA,
      { queue: "general", title: `番号 ${VALID_MY_NUMBER}` },
      person,
      { now: NOW },
    );
    const built = await buildExportArchive(home, {
      id: "exp-test00000000",
      status: "running",
      createdAt: NOW.toISOString(),
      createdBy: "person:legal",
      reason: "review",
      matterId: null,
      scope: { workItemIds: [item.id] },
      classes: ["workitems"],
      attachmentFiles: false,
      redacted: true,
      finishedAt: null,
      bytes: null,
      sha256: null,
      files: null,
      verificationOk: null,
      error: null,
    });
    const text = built.files.get(`workitems/${projectA.id}/${item.id}/item.json`)!.toString("utf8");
    expect(text).toContain("[マイナンバー]");
    expect(text).not.toContain(VALID_MY_NUMBER);
  });
});

describe("personal data guard", () => {
  it("blocks an m365 draft with a valid マイナンバー and audits without the value", async () => {
    let ran = false;
    const tool = wrapToolWithPersonalDataGuard(
      {
        name: "m365_mail_create_draft",
        execute: async () => {
          ran = true;
          return { ok: true };
        },
      },
      { agentId: "main", sessionKey: `agent:main:proj-${projectA.id}-x`, config: {} as KoLoConfig },
    );
    await expect(
      tool.execute("call-1", {
        to: ["a@example.com"],
        subject: "x",
        body: `番号 ${VALID_MY_NUMBER}`,
      }),
    ).rejects.toBeInstanceOf(PersonalDataBlockedError);
    expect(ran).toBe(false);
    const send = guardOutboundCall({
      toolName: "m365_mail_send",
      args: { to: ["a@example.com"], subject: VALID_MY_NUMBER, body: "電話 090-1234-5678" },
      agentId: "main",
      config: {} as KoLoConfig,
      home,
    });
    expect(send.action).toBe("block");
    await flushAudit();
    const auditText = fs
      .readdirSync(path.join(home, "audit"))
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => fs.readFileSync(path.join(home, "audit", n), "utf8"))
      .join("\n");
    expect(auditText).toContain("governance.personalData.block");
    expect(auditText).not.toContain(VALID_MY_NUMBER);
    expect(auditText).not.toContain("090-1234-5678");
    // A Project may turn the block into a warning.
    setProjectOverride({}, home, projectA.id, { personalData: { myNumber: "warn" } }, "p");
    expect(
      guardOutboundCall({
        toolName: "m365_mail_send",
        args: { body: VALID_MY_NUMBER },
        sessionKey: `agent:main:proj-${projectA.id}-x`,
        config: {} as KoLoConfig,
        home,
      }).action,
    ).toBe("warn");
    setProjectOverride({}, home, projectA.id, {}, "p");
  });

  it("masks a valid マイナンバー in every audit row", async () => {
    await appendAudit({
      action: "t.note",
      outcome: "ok",
      source: "test",
      detail: { text: `no ${VALID_MY_NUMBER}` },
    });
    await flushAudit();
    const files = fs.readdirSync(path.join(home, "audit")).filter((n) => n.endsWith(".jsonl"));
    const all = files.map((n) => fs.readFileSync(path.join(home, "audit", n), "utf8")).join("");
    expect(all).toContain("[マイナンバー]");
    expect(all).not.toContain(VALID_MY_NUMBER);
  });
});

describe("data subject requests", () => {
  it("finds a person's data across classes and deletes / anonymizes around holds", async () => {
    const email = "jiro.suzuki@example.jp";
    const at = new Date("2027-05-10T00:00:00Z");
    const a = closedItem(projectA, `依頼者 ${email}`, at);
    const b = closedItem(projectB, `問い合わせ ${email}`, at);
    const t = writeTranscript(
      "main",
      `agent:main:proj-${projectA.id}-dsr`,
      "s-dsr",
      `メール ${email} です`,
      at,
    );
    const hold = createHold(
      home,
      { matterId: "M-3", reason: "dispute", scope: { projectIds: [projectB.id] } },
      "person:legal",
    );

    const report = findSubjectData(
      home,
      { identifier: email, kind: "email", reason: "本人からの削除請求" },
      "person:dpo",
    );
    expect(JSON.stringify(report)).not.toContain(email);
    const byId = new Map(report.matches.map((m) => [m.id, m]));
    expect(byId.get(`${projectA.id}/${a.id}`)?.disposition).toBe("deletable");
    expect(byId.get(`${projectB.id}/${b.id}`)?.disposition).toBe("held");
    expect(report.matches.some((m) => m.class === "transcripts")).toBe(true);
    expect(
      report.matches
        .filter((m) => m.class === "evidence")
        .every((m) => m.disposition !== "deletable"),
    ).toBe(true);

    await expect(
      executeSubjectRequest(
        home,
        { reportId: report.id, identifier: "other@example.jp", mode: "anonymize", reason: "x請求" },
        "p",
      ),
    ).rejects.toThrow(/does not match/);
    const done = await executeSubjectRequest(
      home,
      { reportId: report.id, identifier: email, mode: "anonymize", reason: "本人請求" },
      "person:dpo",
    );
    expect(done.executed?.changed).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(readWorkItem(projectA.id, a.id))).not.toContain(email);
    // A rewrite bumps the revision, so an editor holding the old copy is refused.
    expect(readWorkItem(projectA.id, a.id)?.revision).toBe(a.revision + 1);
    expect(fs.readFileSync(t, "utf8")).not.toContain(email);
    // Held: untouched.
    expect(readWorkItem(projectB.id, b.id)?.title).toContain(email);
    await expect(
      executeSubjectRequest(
        home,
        { reportId: report.id, identifier: email, mode: "delete", reason: "again" },
        "p",
      ),
    ).rejects.toThrow(/already/);

    // Delete mode after the hold is released.
    releaseHold(home, hold.id, "settled", "person:legal");
    const r2 = findSubjectData(
      home,
      { identifier: email, kind: "email", reason: "削除請求" },
      "person:dpo",
    );
    const d2 = await executeSubjectRequest(
      home,
      { reportId: r2.id, identifier: email, mode: "delete", reason: "削除" },
      "person:dpo",
    );
    expect(d2.executed?.changed).toBeGreaterThanOrEqual(1);
    expect(readWorkItem(projectB.id, b.id)).toBeNull();
    expect(d2.executed?.manifestId).toMatch(/^gov-dsr-/);
  });

  it("does not anonymize a work item while another writer holds its lock", async () => {
    const email = "hanako.ito@example.jp";
    const item = closedItem(projectA, `依頼者 ${email}`, new Date("2027-05-11T00:00:00Z"));
    const lock = path.join(workItemDir(projectA.id, item.id), ".lock");
    fs.writeFileSync(lock, "999999\n");
    try {
      const report = findSubjectData(
        home,
        { identifier: email, kind: "email", reason: "本人からの請求" },
        "person:dpo",
      );
      const done = await executeSubjectRequest(
        home,
        { reportId: report.id, identifier: email, mode: "anonymize", reason: "本人請求" },
        "person:dpo",
      );
      expect(done.executed?.changed).toBe(0);
      expect(readWorkItem(projectA.id, item.id)).toMatchObject({
        title: expect.stringContaining(email),
        revision: item.revision,
      });
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }, 15_000);
});
