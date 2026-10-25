// M3: SSO persons read job evidence only per the Project access policy (attach is not enough).
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PersonPrincipal, RoleGrant } from "../identity/types.js";
import { EvidenceRecorder } from "../evidence/recorder.js";
import { setHttpPersonForTest } from "../identity/http.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { projectSessionKey } from "../projects/scope.js";
import { createProject } from "../projects/store.js";
import { createEvidenceHttpHandlers } from "./http-evidence.js";

function fakeRes(): { res: ServerResponse; status: () => number } {
  let status = 0;
  const res = {
    setHeader: () => {},
    end: () => {},
    get statusCode() {
      return status;
    },
    set statusCode(v: number) {
      status = v;
    },
  } as unknown as ServerResponse;
  return { res, status: () => status };
}

function person(
  id: string,
  roles: RoleGrant[],
  extra: Partial<PersonPrincipal> = {},
): PersonPrincipal {
  return {
    kind: "person",
    personId: id,
    principal: `person:${id}`,
    sessionId: "s",
    providerId: "corp",
    issuer: null,
    subject: null,
    email: null,
    displayName: null,
    groups: [],
    roles,
    units: [],
    coverage: [],
    scope: "attach",
    adminAreas: [],
    approvals: false,
    expiresAt: "",
    ...extra,
  };
}

const grant = (role: RoleGrant["role"], unit: string | null = null): RoleGrant => ({
  role,
  unit,
  via: "assignment",
});

describe("job evidence for SSO persons", () => {
  let root = "";
  let home = "";
  let env: NodeJS.ProcessEnv;
  let handlers: ReturnType<typeof createEvidenceHttpHandlers>;
  const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };

  async function status(
    id: string,
    p: PersonPrincipal,
    name: keyof typeof handlers = "getJobEvidence",
  ) {
    const { res, status: s } = fakeRes();
    const req = (async function* () {})() as unknown as IncomingMessage;
    setHttpPersonForTest(req, p);
    await handlers[name](req, res, { url: new URL("/x", "http://127.0.0.1"), params: { id } });
    return s();
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-ev-person-"));
    home = path.join(root, "home");
    fs.mkdirSync(home);
    process.env.KOLO_HOME = home;
    process.env.KOLO_STATE_DIR = home;
    env = { ...process.env, KOLO_HOME: home, KOLO_STATE_DIR: home };
    handlers = createEvidenceHttpHandlers({ gatewayVersion: "test", env });
    const folder = path.join(root, "proj");
    fs.mkdirSync(path.join(folder, "context"), { recursive: true });
    fs.writeFileSync(
      path.join(folder, "context", "workqueue.yaml"),
      [
        "access:",
        "  members:",
        "    - { principal: person:member1, roles: [approver] }",
        "  groups:",
        '    "unit:sales": { roles: [requester] }',
        "",
      ].join("\n"),
    );
    const projectId = createProject(
      { name: "P", folder },
      { createdBy: "owner", template: null },
    ).id;
    const idn = loadOrCreateDeviceIdentity(path.join(home, "identity", "continuity-signing.json"));
    const key = { privateKeyPem: idn.privateKeyPem, publicKeyPem: idn.publicKeyPem };
    for (const [id, sessionKey] of [
      ["job-proj", projectSessionKey("alice", projectId, "c1")],
      ["job-main", "agent:alice:main"],
    ] as const) {
      const r = new EvidenceRecorder(
        { id, agent: "alice", sessionKey, kind: "agent", startedAt: new Date().toISOString() },
        { env, key },
      );
      r.start({ prompt: "p" });
      r.finish({ status: "succeeded", steps: 0, toolCalls: 0, endedAt: new Date().toISOString() });
    }
  });

  afterEach(() => {
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

  test("a member with attach scope cannot read jobs outside their Projects", async () => {
    const outsider = person("outsider", [grant("member")]);
    expect(await status("job-proj", outsider)).toBe(404);
    expect(await status("job-main", outsider)).toBe(404);
    expect(await status("job-proj", outsider, "listJobEvidenceEvents")).toBe(404);
    expect(await status("job-proj", outsider, "getEvidenceView")).toBe(404);
  });

  test("Project members and unit members read the Project's jobs only", async () => {
    const member = person("member1", [grant("member")]);
    expect(await status("job-proj", member)).toBe(200);
    expect(await status("job-main", member)).toBe(404);
    const sales = person("s1", [grant("member", "sales")], { units: ["sales"] });
    expect(await status("job-proj", sales)).toBe(200);
  });

  test("auditors: org-wide read everything, unit-scoped only their units", async () => {
    const auditor = person("a1", [grant("auditor")], { scope: "observe" });
    expect(await status("job-main", auditor)).toBe(200);
    const salesAuditor = person("a2", [grant("auditor", "sales")], {
      scope: "observe",
      coverage: ["role:auditor@sales"],
    });
    expect(await status("job-proj", salesAuditor)).toBe(200);
    expect(await status("job-main", salesAuditor)).toBe(404);
    const hrAuditor = person("a3", [grant("auditor", "hr")], {
      scope: "observe",
      coverage: ["role:auditor@hr"],
    });
    expect(await status("job-proj", hrAuditor)).toBe(404);
  });

  test("org-admin reads every job", async () => {
    const admin = person("o1", [grant("org-admin")]);
    expect(await status("job-main", admin)).toBe(200);
    expect(await status("job-proj", admin)).toBe(200);
  });
});
