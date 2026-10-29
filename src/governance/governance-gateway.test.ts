import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { flushAudit } from "../audit/audit-log.js";
import { createGovernanceHttpHandlers } from "../gateway/http-governance.js";
import { resolveMethodSchemaNames } from "../gateway/protocol/json-schema.js";
import { wsMethodMinScope } from "../gateway/scopes.js";
import { BASE_GATEWAY_METHODS } from "../gateway/server-methods-list.js";
import { handleGatewayRequest } from "../gateway/server-methods.js";
import { GOVERNANCE_APPROVAL_METHODS } from "../gateway/server-methods/governance.js";
import { SSO_PERSON_DECISIONS } from "../identity/connect.js";
import { setHttpPersonForTest } from "../identity/http.js";
import { createProject } from "../projects/store.js";
import { isApprovalMethod } from "../voice/approval-guard.js";
import { readExport } from "./export.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-governance-gw-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;
type Reply = { ok: boolean; payload?: Json; error?: { message: string; details?: Json } };
const context = { broadcast: () => undefined, deps: {} } as unknown as GatewayRequestContext;

function client(kind: "ui" | "agent", scopes: string[]) {
  return {
    connId: `c-${kind}`,
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client:
        kind === "agent"
          ? {
              id: "gateway-client",
              displayName: "agent",
              version: "1",
              platform: "t",
              mode: "backend",
            }
          : { id: "kolo-control-ui", version: "1", platform: "t", mode: "ui" },
      role: "operator",
      scopes,
      device: { id: "dev-person-0001" },
    },
  } as never;
}

const APPROVER = ["operator.read", "operator.write", "operator.approvals"];
async function call(
  method: string,
  params: Record<string, unknown>,
  who: { kind?: "ui" | "agent"; scopes?: string[] } = {},
): Promise<Reply> {
  let reply: Reply | null = null;
  const respond: RespondFn = (ok, payload, error) => {
    reply = { ok, payload, error: error as Reply["error"] };
  };
  await handleGatewayRequest({
    req: { type: "req", id: "1", method, params },
    respond,
    client: client(who.kind ?? "ui", who.scopes ?? APPROVER),
    isWebchatConnect: () => false,
    context,
  });
  return reply!;
}

let projectId = "";

beforeAll(() => {
  const folder = path.join(root, "client");
  fs.mkdirSync(folder, { recursive: true });
  projectId = createProject(
    { name: "Legal", folder, allowedAgents: [] },
    { createdBy: "owner" },
  ).id;
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

describe("governance methods", () => {
  it("are registered with schemas, attach scope, approvals and the voice guard", () => {
    for (const m of [...GOVERNANCE_APPROVAL_METHODS, "governance.policy.get"]) {
      expect(BASE_GATEWAY_METHODS).toContain(m);
      const names = resolveMethodSchemaNames(m);
      expect(names.params, m).toBeDefined();
      expect(names.result, m).toBeDefined();
    }
    expect(wsMethodMinScope("governance.policy.get")).toBe("observe");
    expect(wsMethodMinScope("governance.holds.create")).toBe("attach");
    for (const m of [
      "governance.holds.create",
      "governance.holds.release",
      "governance.export.create",
      "governance.dsr.execute",
    ]) {
      expect(isApprovalMethod(m)).toBe(true);
      expect(SSO_PERSON_DECISIONS.has(m)).toBe(true);
    }
  });

  it("holds are person-only: agents, missing approvals scope and voice are refused", async () => {
    const params = { matterId: "M-9", reason: "訴訟", scope: { projectIds: [projectId] } };
    const agent = await call("governance.holds.create", params, { kind: "agent" });
    expect(agent.ok).toBe(false);
    expect(agent.error?.details?.code).toBe("not_a_person");
    const noApprovals = await call("governance.holds.create", params, {
      scopes: ["operator.read", "operator.write"],
    });
    expect(noApprovals.ok).toBe(false);
    expect(noApprovals.error?.message).toContain("operator.approvals");
    const voice = await call("governance.holds.create", { ...params, origin: "voice" });
    expect(voice.ok).toBe(false);
    const list = await call("governance.holds.list", {}, { kind: "agent" });
    expect(list.error?.details?.code).toBe("not_a_person");
    const noReason = await call("governance.holds.create", {
      matterId: "M",
      scope: { projectIds: [projectId] },
    });
    expect(noReason.ok).toBe(false);

    const created = await call("governance.holds.create", params);
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const id = created.payload.hold.id;
    expect(
      fs.existsSync(path.join(root, "state", "evidence", `gov-${id}-create`, "manifest.json")),
    ).toBe(true);
    const listed = await call("governance.holds.list", {});
    expect(listed.payload.holds.map((h: Json) => h.id)).toContain(id);

    // While held, sessions.delete refuses the Project's conversations.
    const del = await call(
      "sessions.delete",
      { key: `agent:main:proj-${projectId}-abc` },
      { scopes: ["operator.admin"] },
    );
    expect(del.ok).toBe(false);
    expect(del.error?.details?.code).toBe("legal_hold");

    const released = await call("governance.holds.release", { id, reason: "和解" });
    expect(released.payload.hold.status).toBe("released");
    const again = await call("governance.holds.release", { id, reason: "again" });
    expect(again.error?.details?.code).toBe("hold_released");
  });

  it("policy.set refuses evidence below the minimum and audit overrides", async () => {
    const low = await call("governance.policy.set", {
      projectId,
      retention: { evidence: { keepDays: 10 } },
      reason: "test",
    });
    expect(low.error?.details?.code).toBe("retention_below_minimum");
    const audit = await call("governance.policy.set", {
      projectId,
      retention: { audit: { keepDays: 999 } },
      reason: "test",
    });
    expect(audit.error?.details?.code).toBe("org_only_class");
    const ok = await call("governance.policy.set", {
      projectId,
      retention: { transcripts: { keepDays: 90, mode: "anonymize" } },
      personalData: { otherIdentifiers: "block" },
      reason: "社内規程",
    });
    expect(ok.ok, JSON.stringify(ok.error)).toBe(true);
    expect(ok.payload.project.retention.transcripts).toEqual({ keepDays: 90, mode: "anonymize" });
    const read = await call("governance.policy.get", { projectId }, { scopes: ["operator.read"] });
    expect(read.payload.project.personalData.otherIdentifiers).toBe("block");
  });

  it("export runs in the background and downloads only for its creator", async () => {
    const created = await call("governance.export.create", {
      reason: "監査対応",
      scope: { projectIds: [projectId] },
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const id = created.payload.export.id;
    let status = readExport(process.env.KOLO_HOME!, id);
    for (let i = 0; i < 100 && status?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = readExport(process.env.KOLO_HOME!, id);
    }
    expect(status?.status).toBe("done");
    const got = await call("governance.export.get", { id });
    expect(got.payload.export.downloadPath).toBe(`/api/governance/exports/${id}/download`);

    const { downloadGovernanceExport } = createGovernanceHttpHandlers();
    const fakeRes = () => {
      const res = new PassThrough() as unknown as ServerResponse & {
        statusCode: number;
        headers: Record<string, string>;
      };
      res.headers = {};
      res.setHeader = ((k: string, v: string) => {
        res.headers[k.toLowerCase()] = v;
      }) as never;
      return res;
    };
    // A different SSO person: 404.
    const other = {} as IncomingMessage;
    setHttpPersonForTest(other, { principal: "person:someone-else", sessionId: "s" } as never);
    const r1 = fakeRes();
    let body1 = "";
    r1.end = ((b?: string) => {
      body1 = String(b ?? "");
    }) as never;
    await downloadGovernanceExport(other, r1, { url: new URL("http://x"), params: { id } });
    expect(r1.statusCode).toBe(404);
    expect(body1).toContain("export not found");
    // The creator (same device principal as the WS call): 200 zip.
    const creatorReq = {} as IncomingMessage;
    setHttpPersonForTest(creatorReq, { principal: status!.createdBy, sessionId: "s" } as never);
    const r2 = fakeRes();
    await downloadGovernanceExport(creatorReq, r2, { url: new URL("http://x"), params: { id } });
    expect(r2.statusCode).toBe(200);
    expect(r2.headers["content-type"]).toBe("application/zip");
  });

  it("data subject requests are person-only and never echo the identifier", async () => {
    const agent = await call(
      "governance.dsr.find",
      { identifier: "a@example.jp", kind: "email", reason: "請求" },
      { kind: "agent" },
    );
    expect(agent.error?.details?.code).toBe("not_a_person");
    const found = await call("governance.dsr.find", {
      identifier: "nobody@example.jp",
      kind: "email",
      reason: "請求",
    });
    expect(found.ok, JSON.stringify(found.error)).toBe(true);
    expect(JSON.stringify(found.payload)).not.toContain("nobody@example.jp");
    await flushAudit();
    const auditDir = path.join(root, "state", "audit");
    const text = fs
      .readdirSync(auditDir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => fs.readFileSync(path.join(auditDir, n), "utf8"))
      .join("");
    expect(text).toContain("governance.dsr.find");
    expect(text).not.toContain("nobody@example.jp");
  });
});
