// Step-up for decisions, enforced at the gateway: work item approvals, autopilot promotions,
// lifting the emergency stop (autopilot.startAll, policy.release) and identity administration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GatewayIdentityConfig } from "../../config/types.identity.js";
import type { OrgRole, PersonPrincipal, SignInAuth } from "../../identity/types.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";
import { flushAudit } from "../../audit/audit-log.js";
import { resolveKoloHome } from "../../config/kolo-home.js";
import { evidenceRootOf } from "../../governance/store.js";
import { resolveIdentitySettings } from "../../identity/config.js";
import { IdentityService, setIdentityServiceForTest } from "../../identity/service.js";
import { SessionStore } from "../../identity/sessions.js";
import { identityDir, IdentityStore } from "../../identity/store.js";
import { createProject } from "../../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../../projects/templates.js";
import { evidenceBundleDir, listEvidenceBundles } from "../../workitems/evidence.js";
import { readWorkItem } from "../../workitems/store.js";
import { handleGatewayRequest } from "../server-methods.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-stepup-gw-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;
type Reply = { ok: boolean; payload?: Json; error?: { message: string; details?: Json } };
const context = { broadcast: () => {}, deps: {} } as unknown as GatewayRequestContext;

let svc: IdentityService;
function useIdentity(extra: GatewayIdentityConfig = {}) {
  svc = new IdentityService(
    resolveIdentitySettings({
      publicUrl: "https://gateway.example.test",
      providers: [
        {
          id: "corp",
          kind: "oidc",
          issuer: "https://idp.example.test",
          clientId: "k",
          trustEmailForLinking: true,
        },
      ],
      ...extra,
    }),
    {
      store: new IdentityStore({ filePath: null }),
      sessions: new SessionStore({ filePath: null }),
    },
  );
  setIdentityServiceForTest(svc);
}

const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();
const FRESH: SignInAuth = { at: ago(10), methods: ["pwd", "mfa"], context: "urn:acr:mfa" };
const STALE: SignInAuth = { at: ago(900), methods: ["pwd", "mfa"], context: "urn:acr:mfa" };

let n = 0;
/** An SSO person with these roles whose last authentication is `auth` (null: an old session). */
function person(roles: OrgRole[], auth: SignInAuth | null): PersonPrincipal {
  n += 1;
  const email = `user${n}@example.com`;
  for (const role of roles) {
    svc.store.assign(`email:${email}`, role, null, "test");
  }
  const r = svc.signIn({
    providerId: "corp",
    protocol: "oidc",
    issuer: "https://idp.example.test",
    subject: `sub-${n}`,
    email,
    emailVerified: true,
    displayName: `User ${n}`,
    givenName: null,
    familyName: null,
    groups: [],
    idTokenHint: null,
    auth: auth ?? FRESH,
  });
  if (!r.ok) {
    throw new Error(r.reason);
  }
  if (auth) {
    return r.principal;
  }
  // A session saved before 2.5: no recorded authentication.
  delete svc.sessions.get(r.principal.sessionId)!.auth;
  const built = svc.principalForSession(r.principal.sessionId);
  if (!built.ok) {
    throw new Error(built.reason);
  }
  return built.principal;
}

function personClient(p: PersonPrincipal): GatewayClient {
  return {
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "kolo-control-ui", version: "1", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: [],
    },
    person: p,
  } as unknown as GatewayClient;
}

function deviceClient(device: string): GatewayClient {
  return {
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "kolo-control-ui", version: "1", platform: "test", mode: "ui" },
      role: "operator",
      scopes: ["operator.admin"],
      device: { id: device },
    },
  } as unknown as GatewayClient;
}

async function call(client: GatewayClient, method: string, params: Record<string, unknown>) {
  let out: Reply | undefined;
  await handleGatewayRequest({
    req: { type: "req", id: "1", method, params },
    client,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      out = { ok, payload, error: error as Reply["error"] };
    },
    context,
  });
  return out!;
}

function expectStepUp(r: Reply, why: string) {
  expect(r.ok).toBe(false);
  expect(r.error?.details).toMatchObject({
    code: "step_up_required",
    why,
    maxAgeSeconds: expect.any(Number),
    stepUpPath: "/api/identity/sso/step-up",
  });
}

function bundleEvents(dir: string): Json[] {
  return fs
    .readFileSync(path.join(dir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

let projectId = "";
beforeAll(() => {
  const folder = path.join(root, "proc");
  fs.mkdirSync(folder, { recursive: true });
  const template = loadTemplates(resolveTemplatesDir({})).find(
    (t) => t.id === "business-procurement",
  )!;
  projectId = createProject(
    { name: "Procurement", folder },
    { createdBy: "device:dev-requester", template },
  ).id;
});
beforeEach(() => useIdentity());
afterAll(async () => {
  setIdentityServiceForTest(null);
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

const fields = {
  requester: "Sato",
  item: "Laptop",
  quantity: 2,
  amount: 240000,
  vendor: "Vendor A",
  budgetCode: "IT-26",
  neededBy: "2099-01-31",
};

async function itemAwaitingReview(amount = 240000): Promise<string> {
  const owner = deviceClient("dev-requester");
  const created = await call(owner, "workitems.create", {
    projectId,
    queue: "proc-requests",
    title: "Laptops",
    source: { fields: { ...fields, amount } },
  });
  expect(created.ok, created.error?.message).toBe(true);
  const id = created.payload.item.id as string;
  const up = await call(owner, "workitems.update", {
    projectId,
    id,
    patch: { status: "awaiting_review" },
  });
  expect(up.ok, up.error?.message).toBe(true);
  return id;
}

const approve = (id: string) => ({ projectId, id, decision: "approve", comment: "OK" });

describe("work item approvals", () => {
  it("stale, old-session and wrong-method approvals need a step-up; nothing is recorded", async () => {
    const id = await itemAwaitingReview();
    expectStepUp(
      await call(personClient(person(["approver"], STALE)), "workitems.decide", approve(id)),
      "stale",
    );
    expectStepUp(
      await call(personClient(person(["approver"], null)), "workitems.decide", approve(id)),
      "no_auth",
    );
    useIdentity({ stepUp: { requireMethods: ["hwk"] } });
    const r = await call(
      personClient(person(["approver"], FRESH)),
      "workitems.decide",
      approve(id),
    );
    expectStepUp(r, "method");
    expect(r.error?.details.requireMethods).toEqual(["hwk"]);
    const item = readWorkItem(projectId, id)!;
    expect(item.status).toBe("awaiting_review");
    expect(item.history.some((h) => h.action === "decide.approve")).toBe(false);
  });

  it("a fresh approval is recorded with its authentication in history and sealed evidence", async () => {
    const id = await itemAwaitingReview();
    const p = person(["approver"], FRESH);
    const r = await call(personClient(p), "workitems.decide", approve(id));
    expect(r.ok, r.error?.message).toBe(true);
    const authn = {
      authAt: FRESH.at,
      methods: ["pwd", "mfa"],
      context: "urn:acr:mfa",
      protocol: "oidc",
      stepUp: true,
    };
    const item = readWorkItem(projectId, id)!;
    const entry = item.history.find((h) => h.action === "decide.approve")!;
    expect(entry.detail?.authn).toEqual(authn);
    const bundles = listEvidenceBundles(item);
    const events = bundleEvents(evidenceBundleDir(item, bundles[bundles.length - 1]));
    const sealed = JSON.stringify(events);
    expect(sealed).toContain('"stepUp":true');
    expect(sealed).toContain(FRESH.at);
    expect(sealed).not.toMatch(/kss_|idTokenHint|id_token/);
  });

  it("with amountAtLeast, approvals below it go ahead without a step-up (stepUp: false)", async () => {
    useIdentity({ stepUp: { actions: { approvals: { amountAtLeast: 1_000_000 } } } });
    const small = await itemAwaitingReview(240000);
    const r = await call(
      personClient(person(["approver"], STALE)),
      "workitems.decide",
      approve(small),
    );
    expect(r.ok, r.error?.message).toBe(true);
    const entry = readWorkItem(projectId, small)!.history.find(
      (h) => h.action === "decide.approve",
    );
    expect(entry?.detail?.authn).toMatchObject({ stepUp: false });
    const large = await itemAwaitingReview(4_000_000);
    expectStepUp(
      await call(personClient(person(["approver"], STALE)), "workitems.decide", approve(large)),
      "stale",
    );
  });

  it("send back is not covered", async () => {
    const id = await itemAwaitingReview();
    const r = await call(personClient(person(["approver"], STALE)), "workitems.decide", {
      projectId,
      id,
      decision: "send_back",
      comment: "Please attach the quote",
    });
    expect(r.ok, r.error?.message).toBe(true);
  });
});

describe("autopilot and the emergency stop", () => {
  it("a promotion needs a step-up; a demotion does not", async () => {
    const accept = (kind: string) => ({
      projectId: "pnone000000",
      routineId: "r1",
      kind,
      proposed: "L2",
      reason: "Earned it over 30 days",
    });
    const stale = personClient(person(["approver"], STALE));
    expectStepUp(await call(stale, "autopilot.autonomy.accept", accept("promote")), "stale");
    // Past the gate: the handler's own checks answer.
    const demote = await call(stale, "autopilot.autonomy.accept", accept("demote"));
    expect(demote.error?.details?.code).toBe("project_not_found");
    const fresh = personClient(person(["approver"], FRESH));
    const promote = await call(fresh, "autopilot.autonomy.accept", accept("promote"));
    expect(promote.error?.details?.code).toBe("project_not_found");
    expectStepUp(
      await call(
        personClient(person(["approver"], null)),
        "autopilot.autonomy.accept",
        accept("promote"),
      ),
      "no_auth",
    );
  });

  it("autopilot.startAll needs a step-up; stopAll never does", async () => {
    const stale = personClient(person(["approver"], STALE));
    const stop = await call(stale, "autopilot.stopAll", { reason: "incident drill" });
    expect(stop.ok, stop.error?.message).toBe(true);
    expectStepUp(await call(stale, "autopilot.startAll", { reason: "drill over" }), "stale");
    const start = await call(personClient(person(["approver"], FRESH)), "autopilot.startAll", {
      reason: "drill over",
    });
    expect(start.ok, start.error?.message).toBe(true);
  });

  it("policy.release needs a step-up; policy.kill never does", async () => {
    const stale = personClient(person(["security-admin"], STALE));
    const kill = await call(stale, "policy.kill", { all: true, reason: "drill" });
    expect(kill.ok, kill.error?.message).toBe(true);
    expectStepUp(await call(stale, "policy.release", { all: true }), "stale");
    const released = await call(personClient(person(["security-admin"], FRESH)), "policy.release", {
      all: true,
    });
    expect(released.ok, released.error?.message).toBe(true);
  });
});

describe("other person-only decisions", () => {
  const ITEM = "w000000000000";
  const cases: Array<[string, Record<string, unknown>]> = [
    [
      "workitems.clearFlag",
      {
        projectId: "pnone000000",
        id: ITEM,
        flag: "suspected_fraud",
        reason: "Checked with the bank",
      },
    ],
    [
      "workitems.selectSupplier",
      { projectId: "pnone000000", id: ITEM, expectedRevision: 1, supplier: "Vendor A" },
    ],
    [
      "autopilot.approvals.create",
      {
        projectId: "pnone000000",
        routineId: "r1",
        action: "mail.send",
        scope: { maxPerDay: 5 },
        reason: "Weekly report",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ],
    ["governance.holds.release", { id: "h1", reason: "Matter closed" }],
    ["governance.export.create", { reason: "Litigation", scope: { projectIds: ["pnone000000"] } }],
    [
      "governance.dsr.execute",
      { reportId: "r1", identifier: "alice@example.com", mode: "delete", reason: "Request" },
    ],
    ["governance.policy.set", { projectId: "pnone000000", reason: "Shorter retention" }],
    ["governance.retention.run", { dryRun: false, reason: "Monthly run" }],
  ];

  it.each(cases)("%s needs a step-up for a stale or old session", async (method, params) => {
    const stale = await call(personClient(person(["approver"], STALE)), method, params);
    expect(stale.error?.message, method).not.toMatch(/invalid .* params/);
    expectStepUp(stale, "stale");
    expectStepUp(await call(personClient(person(["approver"], null)), method, params), "no_auth");
    if (method === "governance.export.create") {
      return; // a fresh export would start a background job
    }
    // Fresh: past the step-up gate (the handler's own checks answer).
    const fresh = await call(personClient(person(["approver"], FRESH)), method, params);
    expect(fresh.error?.details?.code, method).not.toBe("step_up_required");
  });

  it("protective or read-only calls never wait for a step-up", async () => {
    const stale = personClient(person(["approver"], STALE));
    for (const [method, params] of [
      [
        "autopilot.approvals.revoke",
        { projectId: "pnone000000", id: "s00000000000000", reason: "Stop it" },
      ],
      ["governance.retention.run", { reason: "Preview" }],
      [
        "governance.holds.create",
        { matterId: "M-1", reason: "Litigation", scope: { projectIds: ["p1"] } },
      ],
    ] as const) {
      const r = await call(stale, method, params as Record<string, unknown>);
      expect(r.error?.message ?? "", method).not.toMatch(/invalid .* params/);
      expect(r.error?.details?.code, method).not.toBe("step_up_required");
      if (method === "governance.holds.create") {
        // Recorded with how the person authenticated (not covered: stepUp false).
        const dir = path.join(evidenceRootOf(resolveKoloHome()), `gov-${r.payload.hold.id}-create`);
        const sealed = JSON.stringify(bundleEvents(dir));
        expect(sealed).toContain('"authn"');
        expect(sealed).toContain('"stepUp":false');
      }
    }
  });
});

describe("identity administration", () => {
  it("directory changes need a step-up and seal the authentication", async () => {
    expectStepUp(
      await call(personClient(person(["org-admin"], STALE)), "identity.org.update", { name: "X" }),
      "stale",
    );
    expectStepUp(
      await call(personClient(person(["org-admin"], null)), "identity.org.update", { name: "X" }),
      "no_auth",
    );
    const ok = await call(personClient(person(["org-admin"], FRESH)), "identity.org.update", {
      name: "Example KK",
    });
    expect(ok.ok, ok.error?.message).toBe(true);
    const events = bundleEvents(path.join(identityDir(), ok.payload.evidence.bundle));
    const audit = events.find((e) => e.type === "audit");
    expect(audit.data.authn).toMatchObject({ authAt: FRESH.at, stepUp: true, protocol: "oidc" });
  });

  it("ending sessions is protective and never waits for a step-up", async () => {
    const victim = person(["member"], FRESH);
    const r = await call(
      personClient(person(["security-admin"], STALE)),
      "identity.sessions.revoke",
      {
        personId: victim.personId,
      },
    );
    expect(r.ok, r.error?.message).toBe(true);
  });

  it("stepUp.enabled false, or the action switched off, restores the old behaviour", async () => {
    useIdentity({ stepUp: { enabled: false } });
    const off = await call(personClient(person(["org-admin"], STALE)), "identity.org.update", {
      name: "A",
    });
    expect(off.ok, off.error?.message).toBe(true);
    useIdentity({ stepUp: { actions: { identityAdmin: false } } });
    const actionOff = await call(personClient(person(["org-admin"], null)), "identity.org.update", {
      name: "B",
    });
    expect(actionOff.ok, actionOff.error?.message).toBe(true);
  });

  it("break-glass owners are not persons and are unchanged", async () => {
    const owner = {
      ...deviceClient("dev-owner"),
      breakGlass: { reason: "IdP outage" },
    } as unknown as GatewayClient;
    const r = await call(owner, "identity.org.update", { name: "Break glass KK" });
    expect(r.error?.details?.code).not.toBe("step_up_required");
  });
});
