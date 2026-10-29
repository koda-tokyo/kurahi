import AjvPkg from "ajv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import type { SupplierQuoteInput } from "../quotes/compare.js";
import { flushAudit } from "../audit/audit-log.js";
import { resolveMethodSchemaNames } from "../gateway/protocol/json-schema.js";
import { ProtocolSchemas } from "../gateway/protocol/schema/protocol-schemas.js";
import { wsMethodMinScope } from "../gateway/scopes.js";
import { handleGatewayRequest } from "../gateway/server-methods.js";
import { actorOf } from "../gateway/server-methods/projects.js";
import { createProject, getProject } from "../projects/store.js";
import { isApprovalMethod } from "../voice/approval-guard.js";
import { createWorkItem } from "./lifecycle.js";
import { purchaseOrderSelectionFor } from "./procurement.js";
import { readWorkItem } from "./store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-procurement-gateway-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;
type Reply = { ok: boolean; payload?: Json; error?: { message: string; details?: Json } };
const events: string[] = [];
const context = {
  broadcast: (event: string) => events.push(event),
  deps: {},
} as unknown as GatewayRequestContext;

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
              platform: "test",
              mode: "backend",
            }
          : { id: "kolo-control-ui", version: "1", platform: "test", mode: "ui" },
      role: "operator",
      scopes,
      device: { id: kind === "agent" ? "dev-buyeragent" : "dev-buyer00001" },
    },
  } as never;
}

const ajv = new (AjvPkg as unknown as new (o?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
});
const ADMIN = ["operator.admin"];
const AGENT = { kind: "agent" as const };

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
    client: client(who.kind ?? "ui", who.scopes ?? ADMIN),
    isWebchatConnect: () => false,
    context,
  });
  const r = reply!;
  if (r.ok) {
    const name = resolveMethodSchemaNames(method).result!;
    const validate = ajv.compile(ProtocolSchemas[name]);
    expect(validate(r.payload), `${method}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  }
  return r;
}

const request = [
  { code: "BRG-6204", description: "ベアリング", quantity: 20 },
  { code: "BLT-M8", description: "ボルト M8", quantity: 500 },
];
function quote(supplier: string, prices: Record<string, number>): SupplierQuoteInput {
  return {
    supplier,
    lines: Object.entries(prices).map(([code, unitPrice]) => ({
      code,
      description: code,
      quantity: code === "BRG-6204" ? 20 : 500,
      unitPrice,
      taxRate: 10 as const,
    })),
  };
}
// Sato is lowest (25000), Towa second (27000).
const quotes = [
  quote("Sato Kogyo", { "BRG-6204": 1000, "BLT-M8": 10 }),
  quote("Towa Shoji", { "BRG-6204": 1100, "BLT-M8": 10 }),
];

let projectId = "";
beforeAll(() => {
  const folder = path.join(root, "proc");
  fs.mkdirSync(folder, { recursive: true });
  projectId = createProject(
    { name: "Procurement", folder },
    { createdBy: "device:dev-buyer00001", template: null },
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

function newCase() {
  return createWorkItem(
    getProject(projectId)!,
    { queue: "procurement", title: "Bearings and bolts" },
    { id: "device:dev-buyer00001", kind: "person" },
  );
}

describe("registration", () => {
  it("both methods are typed and attach-scoped; only selectSupplier is an approval method", () => {
    for (const m of ["workitems.recordQuotes", "workitems.selectSupplier"]) {
      const names = resolveMethodSchemaNames(m);
      expect(names.params, m).toBeTruthy();
      expect(names.result, m).toBeTruthy();
      expect(wsMethodMinScope(m)).toBe("attach");
    }
    expect(isApprovalMethod("workitems.selectSupplier")).toBe(true);
    expect(isApprovalMethod("workitems.recordQuotes")).toBe(false);
  });
});

describe("procurement over the gateway", () => {
  it("an agent records quotes but cannot choose; a person's choice records the session actor", async () => {
    const item = newCase();
    const recorded = await call(
      "workitems.recordQuotes",
      { projectId, id: item.id, expectedRevision: item.revision, request, quotes },
      AGENT,
    );
    expect(recorded.ok, recorded.error?.message).toBe(true);
    expect(recorded.payload.item.procurement.quotes).toHaveLength(2);
    expect(events).toContain("workitems.changed");
    const revision = recorded.payload.item.revision as number;

    const byAgent = await call(
      "workitems.selectSupplier",
      { projectId, id: item.id, expectedRevision: revision, supplier: "Sato Kogyo" },
      AGENT,
    );
    expect(byAgent.ok).toBe(false);
    expect(byAgent.error?.details?.code).toBe("not_a_person");
    const byVoice = await call("workitems.selectSupplier", {
      projectId,
      id: item.id,
      expectedRevision: revision,
      supplier: "Sato Kogyo",
      meta: { origin: "voice" },
    });
    expect(byVoice.ok).toBe(false);
    const noScope = await call(
      "workitems.selectSupplier",
      { projectId, id: item.id, expectedRevision: revision, supplier: "Sato Kogyo" },
      { scopes: ["operator.read", "operator.write"] },
    );
    expect(noScope.error?.message).toMatch(/operator.approvals/);
    const forged = await call("workitems.selectSupplier", {
      projectId,
      id: item.id,
      expectedRevision: revision,
      supplier: "Sato Kogyo",
      selectedBy: "device:someone-else",
    });
    expect(forged.ok).toBe(false);
    expect(readWorkItem(projectId, item.id)?.supplierSelection).toBeUndefined();

    const chosen = await call("workitems.selectSupplier", {
      projectId,
      id: item.id,
      expectedRevision: revision,
      supplier: "Sato Kogyo",
    });
    expect(chosen.ok, chosen.error?.message).toBe(true);
    expect(chosen.payload.item.supplierSelection).toMatchObject({
      supplier: "Sato Kogyo",
      selectedBy: actorOf(client("ui", ADMIN)),
      deviatesFromLowest: false,
    });
    // The published item schema types both fields, so the UI can rely on them.
    const itemSchema = ajv.compile(ProtocolSchemas.WorkitemsGetResult);
    const typed = chosen.payload.item;
    expect(itemSchema({ item: { ...typed, supplierSelection: { supplier: 1 } } })).toBe(false);
    expect(itemSchema({ item: { ...typed, procurement: { request: "x" } } })).toBe(false);
    const order = purchaseOrderSelectionFor(readWorkItem(projectId, item.id)!);
    expect(order.selection.selectedBy).toBe(actorOf(client("ui", ADMIN)));
  });

  it("needs the revision, a reason to deviate, and refuses a stale revision", async () => {
    const item = newCase();
    const recorded = await call("workitems.recordQuotes", {
      projectId,
      id: item.id,
      request,
      quotes,
    });
    const revision = recorded.payload.item.revision as number;
    const noRevision = await call("workitems.selectSupplier", {
      projectId,
      id: item.id,
      supplier: "Sato Kogyo",
    });
    expect(noRevision.ok).toBe(false);
    const stale = await call("workitems.selectSupplier", {
      projectId,
      id: item.id,
      expectedRevision: revision - 1,
      supplier: "Sato Kogyo",
    });
    expect(stale.ok).toBe(false);
    const noReason = await call("workitems.selectSupplier", {
      projectId,
      id: item.id,
      expectedRevision: revision,
      supplier: "Towa Shoji",
    });
    expect(noReason.ok).toBe(false);
    expect(noReason.error?.details?.code).toBe("invalid_selection");
    const reasoned = await call("workitems.selectSupplier", {
      projectId,
      id: item.id,
      expectedRevision: revision,
      supplier: "Towa Shoji",
      reason: "Sato cannot deliver before the line restart on 11/2",
    });
    expect(reasoned.ok, reasoned.error?.message).toBe(true);
    expect(reasoned.payload.item.supplierSelection.deviatesFromLowest).toBe(true);
  });

  it("refuses an invalid comparison and a choice on a case without quotes", async () => {
    const item = newCase();
    const bad = await call("workitems.recordQuotes", {
      projectId,
      id: item.id,
      request: [{ code: "X", description: "x", quantity: -1 }],
      quotes: [],
    });
    expect(bad.ok).toBe(false);
    expect(bad.error?.details?.code).toBe("invalid_comparison");
    const none = await call("workitems.selectSupplier", {
      projectId,
      id: item.id,
      expectedRevision: item.revision,
      supplier: "Sato Kogyo",
    });
    expect(none.error?.details?.code).toBe("no_quotes");
  });
});
