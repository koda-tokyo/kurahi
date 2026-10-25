import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileScanner } from "../../src/security/scanner.js";
import { flushAudit } from "../../src/audit/audit-log.js";
import { invokeAsEngine } from "../../src/autopilot/engine-origin.js";
import { ConnectorRuntime } from "../../src/connectors/business/index.js";
import {
  jsonResponse,
  MemorySecretStore,
  mockFetch,
  noSleep,
  on,
  type Route,
} from "../../src/connectors/business/test-helpers.js";
import { projectSessionKey } from "../../src/projects/scope.js";
import { createProject } from "../../src/projects/store.js";
import {
  type AttachmentIntakeInput,
  INBOX_ATTACHMENTS_DIR,
  intakeAttachment,
} from "../../src/security/attachment-intake.js";
import { createM365Tools } from "./index.js";
import { buildClient, readSettings } from "./src/config.js";

const G = "https://graph.microsoft.com/v1.0";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-m365-att-"));
const home = path.join(tmpRoot, "state");
const folder = path.join(tmpRoot, "client");
const prevHome = process.env.KOLO_HOME;
const prevState = process.env.KOLO_STATE_DIR;
let sessionKey = "";

let verdict: "clean" | "infected" = "clean";
const scans: string[] = [];
const scanner: FileScanner = {
  name: "clamav",
  async scan(file) {
    scans.push(file);
    return {
      verdict,
      scanner: "clamav",
      signature: verdict === "infected" ? "Eicar-Test-Signature" : null,
      detail: null,
      ms: 1,
    };
  },
};
const intakeInputs: AttachmentIntakeInput[] = [];
const intake = (input: AttachmentIntakeInput) => {
  intakeInputs.push(input);
  return intakeAttachment(input, {
    scanner,
    config: {
      scanner: "clamav",
      requireScan: true,
      scanTimeoutMs: 2000,
      extractTimeoutMs: 60_000,
      extractMaxOldSpaceMb: 256,
    },
  });
};

function setup(routes: Route[], key = sessionKey) {
  const settings = readSettings({
    tenantId: "11111111-2222-3333-4444-555555555555",
    clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  });
  const client = buildClient(settings)!;
  const secrets = new MemorySecretStore();
  const fetch = mockFetch(routes);
  const audit: unknown[] = [];
  const runtime = new ConnectorRuntime(
    { id: "microsoft-365", client },
    { secrets: () => secrets, fetch, sleep: noSleep, random: () => 0, audit: (r) => audit.push(r) },
  );
  runtime.tokens.save({
    accessToken: "graph-at",
    refreshToken: "rt",
    expiresAt: Date.now() + 3_600_000,
    scopes: client.scopes,
    tokenType: "Bearer",
    obtainedAt: 0,
  });
  const tools = createM365Tools(
    settings,
    runtime,
    { agentId: "main", sessionKey: key },
    async () => "deny",
    { attachmentIntake: intake },
  );
  const run = (name: string, params: Record<string, unknown>) =>
    tools.find((t) => t.name === name)!.execute("c1", params) as Promise<{
      content: Array<{ text: string }>;
      details?: Record<string, unknown>;
    }>;
  return { run, fetch, audit };
}

const meta = (over: Record<string, unknown> = {}) =>
  on("GET", `${G}/me/messages/MSG1/attachments/ATT1?`, () =>
    jsonResponse({
      "@odata.type": "#microsoft.graph.fileAttachment",
      id: "ATT1",
      name: "見積書.txt",
      size: 30,
      contentType: "text/plain",
      ...over,
    }),
  );
const value = (body: Buffer | string) =>
  on("GET", `${G}/me/messages/MSG1/attachments/ATT1/$value`, () => new Response(body));

beforeAll(() => {
  process.env.KOLO_HOME = home;
  process.env.KOLO_STATE_DIR = home;
  fs.mkdirSync(folder, { recursive: true });
  const project = createProject(
    {
      name: "Client",
      folder,
      rules: { readOnly: [], writable: [INBOX_ATTACHMENTS_DIR] },
      mode: "act",
    },
    { createdBy: "owner", home },
  );
  sessionKey = projectSessionKey("main", project.id, "c1");
});

afterAll(async () => {
  await flushAudit();
  for (const [k, v] of [
    ["KOLO_HOME", prevHome],
    ["KOLO_STATE_DIR", prevState],
  ] as const) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("m365_mail_read lists attachments as metadata only", () => {
  it("adds id|attachment, name, size and content type lines, never content", async () => {
    const s = setup([
      on("GET", `${G}/me/messages/MSG1/attachments?`, () =>
        jsonResponse({
          value: [
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: "ATT1",
              name: "invoice\n.pdf",
              size: 1234,
              contentType: "application/pdf",
            },
          ],
        }),
      ),
      on("GET", `${G}/me/messages/MSG1?`, () =>
        jsonResponse({ id: "MSG1", subject: "s", hasAttachments: true, body: { content: "hi" } }),
      ),
    ]);
    const res = await s.run("m365_mail_read", { id: "MSG1" });
    const text = res.content[0].text;
    expect(text).toContain(
      "attachment: MSG1|ATT1 | name: invoice .pdf | size: 1234 | contentType: application/pdf",
    );
    const listCall = s.fetch.calls.find((c) => c.url.includes("/attachments?"))!;
    expect(new URL(listCall.url).searchParams.get("$select")).toBe(
      "id,name,size,contentType,isInline",
    );
  });
});

describe("m365_mail_attachment_fetch", () => {
  it("clean: quarantine → scan → inbox-attachments; returns the path and text, never bytes", async () => {
    verdict = "clean";
    const s = setup([meta(), value("お見積りは 12,000 円です")]);
    const res = await s.run("m365_mail_attachment_fetch", { ref: "MSG1|ATT1" });
    expect(res.details?.attachment).toMatchObject({
      status: "accepted",
      verdict: "clean",
      messageId: "MSG1",
      attachmentId: "ATT1",
    });
    const rel = (res.details!.attachment as { path: string }).path;
    expect(rel.startsWith("inbox-attachments/")).toBe(true);
    expect(fs.existsSync(path.join(folder, rel))).toBe(true);
    expect(res.content[0].text).toContain(`stored: ${rel}`);
    expect(res.content[0].text).toMatch(/EXTERNAL_UNTRUSTED_CONTENT/);
    // The scanner saw the quarantine copy in the Project data area, not the client folder.
    expect(scans.at(-1)).toContain(path.join(home, "projects"));
    expect(scans.at(-1)!.startsWith(folder)).toBe(false);
    expect(s.fetch.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/v1.0/me/messages/MSG1/attachments/ATT1",
      "/v1.0/me/messages/MSG1/attachments/ATT1/$value",
    ]);
  }, 90_000);

  it("infected: refused with a code, nothing stored, not an error result", async () => {
    verdict = "infected";
    const before = fs.readdirSync(path.join(folder, INBOX_ATTACHMENTS_DIR));
    const s = setup([meta({ name: "eicar.txt" }), value("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR")]);
    const res = await s.run("m365_mail_attachment_fetch", {
      messageId: "MSG1",
      attachmentId: "ATT1",
    });
    expect(res.details?.error).toBeUndefined();
    expect(res.details?.attachment).toMatchObject({
      status: "refused",
      code: "infected",
      stage: "scan",
    });
    expect(res.content[0].text).toMatch(/refused \(infected\)/);
    expect(res.content[0].text).not.toContain("inbox-attachments/");
    expect(fs.readdirSync(path.join(folder, INBOX_ATTACHMENTS_DIR))).toEqual(before);
  });

  it.each([
    ["#microsoft.graph.itemAttachment", "item_attachment"],
    ["#microsoft.graph.referenceAttachment", "reference_attachment"],
  ])("refuses %s before downloading (%s)", async (type, code) => {
    const s = setup([meta({ "@odata.type": type })]);
    const res = await s.run("m365_mail_attachment_fetch", { ref: "MSG1|ATT1" });
    expect(res.details?.attachment).toMatchObject({ status: "refused", code });
    expect(s.fetch.calls).toHaveLength(1);
  });

  it("refuses over 20 MB from the metadata, before downloading", async () => {
    const s = setup([meta({ size: 20 * 1024 * 1024 + 1 })]);
    const res = await s.run("m365_mail_attachment_fetch", { ref: "MSG1|ATT1" });
    expect(res.details?.attachment).toMatchObject({ status: "refused", code: "too_large" });
    expect(s.fetch.calls).toHaveLength(1);
  });

  it("refuses an executable by content whatever the name says", async () => {
    verdict = "clean";
    const s = setup([meta({ name: "invoice.pdf" }), value(Buffer.from([0x4d, 0x5a, 0x90, 0]))]);
    const res = await s.run("m365_mail_attachment_fetch", { ref: "MSG1|ATT1" });
    expect(res.details?.attachment).toMatchObject({ status: "refused", code: "executable" });
  });

  it("works only in a Project session, and checks ids before any request", async () => {
    const out = setup([], "agent:main:t");
    expect(
      (await out.run("m365_mail_attachment_fetch", { ref: "MSG1|ATT1" })).content[0].text,
    ).toMatch(/^Error: unsupported/);
    const s = setup([]);
    expect(
      (await s.run("m365_mail_attachment_fetch", { messageId: "../../users/x", attachmentId: "a" }))
        .content[0].text,
    ).toMatch(/^Error: bad_request/);
    expect(s.fetch.calls).toHaveLength(0);
  });

  it("knows the autopilot run it is fetched for (engine invocation only)", async () => {
    verdict = "clean";
    const s = setup([meta(), value("plain")]);
    await invokeAsEngine(
      {
        sessionKey,
        tool: "m365_mail_attachment_fetch",
        engine: {
          projectId: "p",
          routineId: "inbox",
          runId: "r1",
          action: null,
          approvalId: null,
          templateId: null,
          tz: "Asia/Tokyo",
        },
      },
      () => s.run("m365_mail_attachment_fetch", { ref: "MSG1|ATT1" }),
    );
    expect(intakeInputs.at(-1)).toMatchObject({
      actor: "autopilot:inbox",
      run: { routineId: "inbox", runId: "r1" },
    });
  }, 90_000);
});
