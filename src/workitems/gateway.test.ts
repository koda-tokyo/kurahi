import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { flushAudit } from "../audit/audit-log.js";
import {
  resolveEventSchemaName,
  resolveMethodSchemaNames,
} from "../gateway/protocol/json-schema.js";
import { wsMethodMinScope } from "../gateway/scopes.js";
import { BASE_GATEWAY_METHODS, GATEWAY_EVENTS } from "../gateway/server-methods-list.js";
import { handleGatewayRequest } from "../gateway/server-methods.js";
import {
  setDraftRunnerForTests,
  WORKITEMS_READ_METHODS,
  WORKITEMS_WRITE_METHODS,
} from "../gateway/server-methods/workitems.js";
import { createProject } from "../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../projects/templates.js";
import { readWorkItem } from "./store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-workitems-gw-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

// Loose JSON view of gateway replies (tests only).
// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;
type Reply = { ok: boolean; payload?: Json; error?: { message: string; details?: Json } };
const events: Array<{ event: string; payload: Json }> = [];
const context = {
  broadcast: (event: string, payload: unknown) => events.push({ event, payload }),
  deps: {},
} as unknown as GatewayRequestContext;

function client(kind: "ui" | "agent" | "node", scopes: string[], device = "dev-person-0001") {
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
              platform: "test",
              mode: "backend",
            }
          : { id: "kolo-control-ui", version: "1", platform: "test", mode: "ui" },
      role: kind === "node" ? "node" : "operator",
      scopes,
      device: { id: device },
    },
  } as never;
}

const ADMIN = ["operator.admin"];
async function call(
  method: string,
  params: Record<string, unknown>,
  who: { kind?: "ui" | "agent" | "node"; scopes?: string[]; device?: string } = {},
): Promise<Reply> {
  let reply: Reply | null = null;
  const respond: RespondFn = (ok, payload, error) => {
    reply = { ok, payload, error: error as Reply["error"] };
  };
  await handleGatewayRequest({
    req: { type: "req", id: "1", method, params },
    respond,
    client: client(who.kind ?? "ui", who.scopes ?? ADMIN, who.device),
    isWebchatConnect: () => false,
    context,
  });
  return reply!;
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

afterAll(async () => {
  setDraftRunnerForTests(null);
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

const fields = {
  requester: "Sato",
  item: "Laptop",
  quantity: 2,
  amount: 240000,
  vendor: "Vendor A",
  budgetCode: "IT-26",
  neededBy: "2099-01-31",
};

describe("protocol and registration", () => {
  it("every method is listed, typed, scoped and the event has a schema", () => {
    for (const m of [...WORKITEMS_READ_METHODS, ...WORKITEMS_WRITE_METHODS]) {
      expect(BASE_GATEWAY_METHODS).toContain(m);
      const names = resolveMethodSchemaNames(m);
      expect(names.params, m).toBeTruthy();
      expect(names.result, m).toBeTruthy();
    }
    expect(GATEWAY_EVENTS).toContain("workitems.changed");
    expect(resolveEventSchemaName("workitems.changed")).toBe("WorkitemsChangedEvent");
    expect(wsMethodMinScope("workitems.list")).toBe("observe");
    expect(wsMethodMinScope("workitems.decide")).toBe("attach");
  });

  it("refuses invalid params", async () => {
    const r = await call("workitems.create", {
      projectId,
      queue: "proc-requests",
      title: "x",
      bogus: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/invalid workitems.create params/);
    const s = await call("workitems.list", { projectId, limit: 201 });
    expect(s.ok).toBe(false);
  });
});

describe("work queue over the gateway", () => {
  it("create → assignAgent → events → person-only decide → evidence verifies", async () => {
    setDraftRunnerForTests(async (req) => {
      expect(req.agentId).toBe("main");
      return { text: `# 発注案\nVendor A, 2 × 120,000 JPY.\n\n(${req.runId})` };
    });
    const created = await call(
      "workitems.create",
      { projectId, queue: "proc-requests", title: "Laptops", source: { fields } },
      { device: "dev-requester" },
    );
    expect(created.ok).toBe(true);
    const id = created.payload.item.id as string;
    expect(created.payload.item.checks.find((c: Json) => c.policyId === "proc.quotes").result).toBe(
      "warn",
    );

    const assigned = await call("workitems.assignAgent", { projectId, id });
    expect(assigned.ok).toBe(true);
    expect(assigned.payload.item.status).toBe("drafting");
    for (let i = 0; i < 50 && readWorkItem(projectId, id)?.status === "drafting"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const got = await call("workitems.get", { projectId, id }, { scopes: ["operator.read"] });
    expect(got.payload.item.status).toBe("awaiting_review");
    expect(got.payload.item.requiredApprovals).toBe(1);
    const changed = events.filter((e) => e.event === "workitems.changed" && e.payload.id === id);
    expect(changed.map((e) => e.payload.action)).toEqual(["create", "assign_agent", "draft"]);
    expect(JSON.stringify(changed)).not.toContain("Laptops");

    // Agents, nodes and voice never decide; nor does a credential without operator.approvals.
    const asAgent = await call(
      "workitems.decide",
      { projectId, id, decision: "approve" },
      { kind: "agent" },
    );
    expect(asAgent.ok).toBe(false);
    expect(asAgent.error?.details?.code).toBe("not_a_person");
    const asNode = await call(
      "workitems.decide",
      { projectId, id, decision: "approve" },
      { kind: "node" },
    );
    expect(asNode.ok).toBe(false);
    const byVoice = await call("workitems.decide", {
      projectId,
      id,
      decision: "approve",
      meta: { origin: "voice" },
    });
    expect(byVoice.error?.message).toMatch(/cannot be approved by voice/);
    const noScope = await call(
      "workitems.decide",
      { projectId, id, decision: "approve" },
      { scopes: ["operator.read", "operator.write"] },
    );
    expect(noScope.error?.message).toMatch(/operator.approvals/);
    const self = await call(
      "workitems.decide",
      { projectId, id, decision: "approve" },
      { device: "dev-requester" },
    );
    expect(self.error?.details?.code).toBe("separation_of_duties");
    expect(readWorkItem(projectId, id)?.status).toBe("awaiting_review");

    const ok = await call(
      "workitems.decide",
      {
        projectId,
        id,
        decision: "approve",
        comment: "OK",
        expectedRevision: got.payload.item.revision,
      },
      { scopes: ["operator.read", "operator.approvals"] },
    );
    expect(ok.ok).toBe(true);
    expect(ok.payload.item.status).toBe("approved");

    const ev = await call("workitems.evidence", { projectId, id });
    expect(ev.payload.chainOk).toBe(true);
    expect(ev.payload.bundles.map((b: Json) => b.status)).toEqual([
      "new",
      "drafting",
      "awaiting_review",
      "approved",
    ]);
    const dir = path.join(
      root,
      "state",
      "projects",
      projectId,
      "workitems",
      id,
      "evidence",
      ev.payload.bundles[3].bundle,
    );
    const file = path.join(dir, "events.jsonl");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"OK"', '"ok!"'));
    const tampered = await call("workitems.evidence", { projectId, id });
    expect(tampered.payload.chainOk).toBe(false);
    expect(tampered.payload.bundles[3].ok).toBe(false);
  });

  it("override reasons are validated, and list/config answer the UI", async () => {
    const created = await call("workitems.create", {
      projectId,
      queue: "proc-requests",
      title: "Server",
      source: { fields: { ...fields, amount: 6_000_000 } },
      priority: "urgent",
    });
    const id = created.payload.item.id as string;
    await call("workitems.update", { projectId, id, patch: { status: "awaiting_review" } });
    const approver = { device: "dev-approver" };
    const short = await call(
      "workitems.decide",
      { projectId, id, decision: "approve", override: { reason: "ok" } },
      approver,
    );
    expect(short.ok).toBe(false);
    const blocked = await call(
      "workitems.decide",
      { projectId, id, decision: "approve" },
      approver,
    );
    expect(blocked.error?.details).toMatchObject({
      code: "checks_failed",
      failing: ["proc.amount"],
    });
    const list = await call("workitems.list", {
      projectId,
      status: "awaiting_review",
      priority: ["urgent"],
    });
    expect(list.payload.items.map((i: Json) => i.id)).toEqual([id]);
    expect(list.payload.items[0].history).toBeUndefined();
    const cfg = await call("workitems.config", { projectId });
    expect(cfg.payload.queues[0].id).toBe("proc-requests");
    expect(cfg.payload.source.kind).toBe("template");
  });
});

describe("cross-process concurrency", () => {
  it("three processes updating one item lose nothing", async () => {
    const created = await call("workitems.create", {
      projectId,
      queue: "proc-requests",
      title: "Race",
    });
    const id = created.payload.item.id as string;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const script = path.join(root, "race.mts");
    fs.writeFileSync(
      script,
      [
        // file:// URLs: on Windows an absolute path is not a valid ESM specifier.
        `import { getProject } from ${JSON.stringify(pathToFileURL(path.join(here, "../projects/store.ts")).href)};`,
        `import { updateWorkItem } from ${JSON.stringify(pathToFileURL(path.join(here, "lifecycle.ts")).href)};`,
        `const p = getProject(${JSON.stringify(projectId)});`,
        `for (let i = 0; i < 10; i++) updateWorkItem(p, ${JSON.stringify(id)}, { title: "r" + process.argv[2] + "-" + i }, { id: "device:race", kind: "person" }, undefined);`,
      ].join("\n"),
    );
    const runs = [1, 2, 3].map(
      (n) =>
        new Promise<number>((resolve) => {
          const child = spawn(process.execPath, ["--import", "tsx", script, String(n)], {
            env: process.env,
            stdio: ["ignore", "ignore", "pipe"],
          });
          let err = "";
          child.stderr.on("data", (d) => (err += String(d)));
          child.on("exit", (code) => {
            if (code !== 0) {
              console.error(err.slice(0, 2000));
            }
            resolve(code ?? 1);
          });
        }),
    );
    expect(await Promise.all(runs)).toEqual([0, 0, 0]);
    const after = readWorkItem(projectId, id)!;
    expect(after.revision).toBe(created.payload.item.revision + 30);
    expect(after.history.filter((h) => h.action === "update")).toHaveLength(30);
  }, 60_000);
});
