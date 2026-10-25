// m365_mail_send under an autopilot standing approval: only an ENGINE invocation (never an agent
// session) with a valid approval sends without asking a person; everything else asks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { Project } from "../../src/projects/types.js";
import { flushAudit } from "../../src/audit/audit-log.js";
import { createStandingApproval, revokeStandingApproval } from "../../src/autopilot/approvals.js";
import { invokeAsEngine, type EngineCallInfo } from "../../src/autopilot/engine-origin.js";
import { routineSessionKey } from "../../src/autopilot/runner.js";
import { dayIn } from "../../src/autopilot/standing-send.js";
import { approvalUsesOn, mutateApprovals } from "../../src/autopilot/store.js";
import {
  type ConnectorAuditSink,
  ConnectorRuntime,
  clearConnectorStatusForTest,
} from "../../src/connectors/business/index.js";
import {
  MemorySecretStore,
  mockFetch,
  noSleep,
  on,
} from "../../src/connectors/business/test-helpers.js";
import { createProject } from "../../src/projects/store.js";
import { createM365Tools } from "./index.js";
import { buildClient, readSettings } from "./src/config.js";

const G = "https://graph.microsoft.com/v1.0";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-m365-standing-"));
const home = path.join(root, "state");
const saved = process.env.KOLO_HOME;
process.env.KOLO_HOME = home;

let project: Project;
let sessionKey = "";
const PERSON = { id: "device:person", kind: "person" as const };

function writeRoutine(level: string) {
  fs.writeFileSync(
    path.join(project.folder, "context", "autopilot.yaml"),
    YAML.stringify({
      version: 1,
      routines: [
        {
          id: "acks",
          edition: "business",
          area: "secretariat",
          trigger: { interval: 60 },
          reasoning: { prompt: "mail-triage" },
          actions: ["mail.send"],
          level,
        },
      ],
    }),
  );
}

function approve(maxPerDay = 5) {
  return createStandingApproval(
    project,
    {
      routineId: "acks",
      action: "mail.send",
      scope: { domains: ["client.example.jp"], templates: ["ack"], maxPerDay },
      reason: "acknowledge known clients",
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    },
    PERSON,
  );
}

function setup(toolSession = sessionKey) {
  const settings = readSettings({
    tenantId: "11111111-2222-3333-4444-555555555555",
    clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    write: { mailSend: true },
  });
  const client = buildClient(settings)!;
  const fetch = mockFetch([
    on("POST", `${G}/me/sendMail`, () => new Response(null, { status: 202 })),
  ]);
  const secrets = new MemorySecretStore();
  const audit: Parameters<ConnectorAuditSink>[0][] = [];
  const runtime = new ConnectorRuntime(
    { id: "microsoft-365", client },
    {
      secrets: () => secrets,
      fetch,
      sleep: noSleep,
      random: () => 0,
      audit: (r) => void audit.push(r),
    },
  );
  runtime.tokens.save({
    accessToken: "graph-at",
    refreshToken: "rt",
    expiresAt: Date.now() + 3_600_000,
    scopes: client.scopes,
    tokenType: "Bearer",
    obtainedAt: 0,
  });
  const asked: Array<Record<string, unknown>> = [];
  const tools = createM365Tools(
    settings,
    runtime,
    { agentId: "main", sessionKey: toolSession },
    async (p) => {
      asked.push(p.args);
      return "deny";
    },
  );
  const send = tools.find((t) => t.name === "m365_mail_send")!;
  const run = (params: Record<string, unknown>) =>
    send.execute("call-1", params) as Promise<{
      content: Array<{ text: string }>;
      details?: Record<string, unknown>;
    }>;
  return { run, fetch, audit, asked };
}

const MAIL = { to: ["tanaka@client.example.jp"], subject: "受領", body: "受領しました" };
const engine = (approvalId: string | null, over: Partial<EngineCallInfo> = {}): EngineCallInfo => ({
  projectId: project.id,
  routineId: "acks",
  runId: "rtestrun0000001",
  action: "mail.send",
  approvalId,
  templateId: "ack",
  tz: "Asia/Tokyo",
  home,
  ...over,
});
const asEngine = <T>(fn: () => Promise<T>, info: EngineCallInfo, session = sessionKey) =>
  invokeAsEngine({ sessionKey: session, tool: "m365_mail_send", engine: info }, fn);
const usesToday = (id: string) =>
  approvalUsesOn(project.id, dayIn(new Date(), "Asia/Tokyo"), home)[id] ?? 0;

beforeAll(() => {
  const folder = path.join(root, "proj");
  fs.mkdirSync(path.join(folder, "context"), { recursive: true });
  project = createProject({ name: "Acks", folder }, { createdBy: "owner", home });
  sessionKey = routineSessionKey("main", project.id, "acks");
});

beforeEach(() => {
  clearConnectorStatusForTest();
  writeRoutine("L3");
});

afterAll(async () => {
  await flushAudit();
  if (saved === undefined) {
    delete process.env.KOLO_HOME;
  } else {
    process.env.KOLO_HOME = saved;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("m365_mail_send under a standing approval", () => {
  it("an agent session cannot use one: no argument for it, and it always asks a person", async () => {
    const a = approve();
    const s = setup();
    const res = await s.run({ ...MAIL, approvalId: a.id, standingApprovalId: a.id });
    expect(res.content[0].text).toMatch(/^Error: approval_denied/);
    expect(s.asked).toHaveLength(1);
    expect(s.fetch.calls).toHaveLength(0);
    expect(usesToday(a.id)).toBe(0);
  });

  it("an engine call with a valid approval sends once without asking and counts the use", async () => {
    const a = approve();
    const s = setup();
    const { value: res, used } = await asEngine(() => s.run(MAIL), engine(a.id));
    expect(res.content[0].text).toBe(`Sent to 1 recipient(s) under standing approval ${a.id}.`);
    expect(res.details).toEqual({ standingApprovalId: a.id });
    expect(used).toEqual({ approvalId: a.id, usesToday: 1 });
    expect(s.asked).toHaveLength(0);
    expect(s.fetch.calls).toHaveLength(1);
    expect(usesToday(a.id)).toBe(1);
    // The connector audit row names the approval (an id only, no content).
    expect(s.audit.at(-1)).toMatchObject({
      action: "connector.microsoft-365.mail.send",
      outcome: "ok",
      detail: { ids: [a.id] },
    });
    // One engine call, one send: a second send in the same call asks a person.
    const again = await asEngine(async () => {
      await s.run(MAIL);
      return s.run(MAIL);
    }, engine(a.id));
    expect(again.used?.approvalId).toBe(a.id);
    expect(again.fallback?.code).toBe("approval_already_used");
    expect(s.asked).toHaveLength(1);
  });

  it("a reply id never widens the recipients: one sendMail to the approved to/cc only", async () => {
    const a = approve();
    const s = setup();
    const params = { ...MAIL, replyToMessageId: "AAMkThreadWithOtherRecipients" };
    const { used } = await asEngine(() => s.run(params), engine(a.id));
    expect(used?.approvalId).toBe(a.id);
    // No createReply / replyAll: those would address the original thread's recipients.
    expect(s.fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${G}/me/sendMail`]);
    const { message } = JSON.parse(s.fetch.calls[0].body);
    expect(message.toRecipients).toEqual([
      { emailAddress: { address: "tanaka@client.example.jp" } },
    ]);
    expect(message.ccRecipients ?? []).toEqual([]);
    expect(message.bccRecipients).toBeUndefined();
  });

  it("falls back to asking a person when anything does not match", async () => {
    const a = approve();
    const cases: Array<[string, () => Promise<unknown>]> = [
      ["recipient_out_of_scope", () => s.run({ ...MAIL, cc: ["boss@elsewhere.example"] })],
      ["template_out_of_scope", () => s.run(MAIL)],
      ["session_mismatch", () => other.run(MAIL)],
      ["no_standing_approval", () => s.run(MAIL)],
      ["approval_not_found", () => s.run(MAIL)],
    ];
    const s = setup();
    const other = setup("agent:main:proj-" + project.id + "-somechat");
    const infos = [
      engine(a.id),
      engine(a.id, { templateId: "other" }),
      engine(a.id),
      engine(null),
      engine("snotreal0000000"),
    ];
    for (const [i, [code, fn]] of cases.entries()) {
      const out = await asEngine(fn, infos[i]);
      expect(out.used, code).toBeNull();
      expect(out.fallback?.code, code).toBe(code);
    }
    expect(s.asked.length + other.asked.length).toBe(cases.length);
    expect(s.fetch.calls.length + other.fetch.calls.length).toBe(0);
    expect(usesToday(a.id)).toBe(0);
  });

  it("expired, revoked, over-limit and non-L3 approvals fall back", async () => {
    const s = setup();
    const expired = approve();
    mutateApprovals(
      project.id,
      (all) => {
        all.find((x) => x.id === expired.id)!.expiresAt = new Date(Date.now() - 1000).toISOString();
      },
      home,
    );
    expect((await asEngine(() => s.run(MAIL), engine(expired.id))).fallback?.code).toBe(
      "approval_expired",
    );

    const revoked = approve();
    revokeStandingApproval(project, revoked.id, "no longer needed", PERSON);
    expect((await asEngine(() => s.run(MAIL), engine(revoked.id))).fallback?.code).toBe(
      "approval_revoked",
    );

    const once = approve(1);
    expect((await asEngine(() => s.run(MAIL), engine(once.id))).used?.approvalId).toBe(once.id);
    expect((await asEngine(() => s.run(MAIL), engine(once.id))).fallback?.code).toBe(
      "approval_daily_limit",
    );
    expect(usesToday(once.id)).toBe(1);

    const valid = approve();
    writeRoutine("L2");
    expect((await asEngine(() => s.run(MAIL), engine(valid.id))).fallback?.code).toBe(
      "level_too_low",
    );
    // Exactly one real send (the in-limit one); every other call asked a person.
    expect(s.fetch.calls).toHaveLength(1);
    expect(s.asked).toHaveLength(4);
  });
});
