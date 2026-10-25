import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { KoLoConfig } from "../config/config.js";
import { __resetJobsForTest } from "../agents/jobs.js";
import { flushAudit } from "../audit/audit-log.js";
import { __resetFactoryRuntimeForTest } from "../factory/runtime.js";
import { __resetFactoryForTest, createCard, getCard } from "../factory/store.js";
import { createFactoryHttpHandlers } from "./http-factory.js";
import { setHttpPrincipal } from "./pair-auth.js";

type Captured = { status: number; body: string; headers: Record<string, string> };

function fakeRes(): { res: ServerResponse; captured: () => Captured } {
  let status = 0;
  let body = "";
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    end: (chunk?: string) => {
      body = chunk ?? "";
    },
    get statusCode() {
      return status;
    },
    set statusCode(v: number) {
      status = v;
    },
  } as unknown as ServerResponse;
  return { res, captured: () => ({ status, body, headers }) };
}

function fakeReq(body = ""): IncomingMessage {
  return (async function* () {
    if (body) {
      yield Buffer.from(body);
    }
  })() as unknown as IncomingMessage;
}

const REPO = path.join(os.tmpdir(), "repo-alice");

describe("factory HTTP handlers", () => {
  let home = "";
  let config: KoLoConfig;
  let handlers: ReturnType<typeof createFactoryHttpHandlers>;

  async function call(
    name: keyof typeof handlers,
    opts: {
      id?: string;
      query?: string;
      body?: string;
      principal?: Parameters<typeof setHttpPrincipal>[1];
    } = {},
  ) {
    const { res, captured } = fakeRes();
    const req = fakeReq(opts.body);
    if (opts.principal) {
      setHttpPrincipal(req, opts.principal);
    }
    await handlers[name](req, res, {
      url: new URL(`/x${opts.query ?? ""}`, "http://127.0.0.1"),
      params: opts.id ? { id: opts.id } : {},
    });
    const c = captured();
    return { ...c, json: () => JSON.parse(c.body) as Record<string, unknown> };
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-factory-http-"));
    process.env.KOLO_STATE_DIR = home;
    process.env.KOLO_HOME = home;
    __resetJobsForTest();
    __resetFactoryForTest({ env: process.env });
    __resetFactoryRuntimeForTest();
    config = {
      agents: { list: [{ id: "alice", default: true }] },
      factory: { defaultRepo: REPO },
    } as unknown as KoLoConfig;
    handlers = createFactoryHttpHandlers({ getConfig: () => config, gatewayVersion: "test" });
  });

  afterEach(async () => {
    // Card handlers append audit entries without awaiting them; drain before removing home.
    await flushAudit();
    __resetFactoryForTest();
    __resetFactoryRuntimeForTest();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("boards and cards start empty, then reflect created cards with counts", async () => {
    expect((await call("listFactoryBoards")).json()).toEqual({ ok: true, boards: [] });
    const created = await call("createFactoryCard", {
      body: JSON.stringify({ goal: "Add a /health endpoint" }),
    });
    expect(created.status).toBe(200);
    const card = created.json().card as { id: string; owner: string; repo: string; column: string };
    expect(card.owner).toBe("alice");
    expect(card.repo).toBe(REPO);
    expect(card.column).toBe("inbox");
    const boards = (await call("listFactoryBoards")).json().boards as Array<{
      id: string;
      counts: Record<string, number>;
    }>;
    expect(boards[0].id).toBe("main");
    expect(boards[0].counts).toMatchObject({ inbox: 1, spec: 0, merged: 0 });
    const cards = (await call("listFactoryCards", { query: "?column=inbox" })).json()
      .cards as Array<{
      id: string;
      timelineLength: number;
    }>;
    expect(cards).toHaveLength(1);
    expect(cards[0].timelineLength).toBe(1);
    expect((await call("listFactoryCards", { query: "?column=nope" })).status).toBe(400);
    expect((await call("listFactoryCards", { query: "?limit=0" })).status).toBe(400);
  });

  test("input errors and unknown cards answer 400 and 404", async () => {
    expect((await call("createFactoryCard", { body: "[1]" })).status).toBe(400);
    const noGoal = await call("createFactoryCard", { body: JSON.stringify({ goal: "" }) });
    expect(noGoal.status).toBe(400);
    expect(noGoal.json().code).toBe("input");
    const badRepo = await call("createFactoryCard", {
      body: JSON.stringify({ goal: "x", repo: "relative" }),
    });
    expect(badRepo.status).toBe(400);
    expect((await call("getFactoryCard", { id: "missing" })).status).toBe(404);
    expect((await call("moveFactoryCard", { id: "missing", body: '{"to":"spec"}' })).status).toBe(
      404,
    );
    expect((await call("runFactoryCard", { id: "missing", body: "{}" })).status).toBe(404);
    expect((await call("cancelFactoryCard", { id: "missing" })).status).toBe(404);
  });

  test("moves go through the state machine and record the caller", async () => {
    const card = createCard({ goal: "x", repo: REPO, owner: "alice" });
    const bad = await call("moveFactoryCard", { id: card.id, body: '{"to":"ready"}' });
    expect(bad.status).toBe(409);
    expect(bad.json().code).toBe("transition");
    expect((await call("moveFactoryCard", { id: card.id, body: '{"to":"later"}' })).status).toBe(
      400,
    );
    const ok = await call("moveFactoryCard", {
      id: card.id,
      body: JSON.stringify({ to: "spec", reason: "hand-written spec" }),
      principal: { kind: "owner", scope: "owner", method: "token" } as never,
    });
    expect(ok.status).toBe(200);
    const moved = ok.json().card as {
      column: string;
      timeline: Array<{ by: string; text: string }>;
    };
    expect(moved.column).toBe("spec");
    expect(moved.timeline[1].by).toBe("owner:token");
    expect(moved.timeline[1].text).toContain("hand-written spec");
    const shown = await call("getFactoryCard", { id: card.id });
    expect(shown.json()).toMatchObject({ ok: true, running: false });
  });

  test("run and cancel report the engine state honestly", async () => {
    const card = createCard({ goal: "x", repo: REPO, owner: "alice" });
    const notConfigured = await call("runFactoryCard", { id: card.id, body: "{}" });
    expect(notConfigured.status).toBe(409);
    expect(notConfigured.json().code).toBe("not_configured");
    const notRunning = await call("cancelFactoryCard", { id: card.id });
    expect(notRunning.status).toBe(409);
    expect(notRunning.json().code).toBe("not_running");
    const withRun = await call("createFactoryCard", {
      body: JSON.stringify({ goal: "y", run: true }),
    });
    expect(withRun.status).toBe(409);
    expect(withRun.json().code).toBe("not_configured");
    expect(getCard((withRun.json().card as { id: string }).id)?.column).toBe("inbox");
  });

  test("the Kanban page is static, light, script-inline and token-free", async () => {
    const page = await call("getFactoryView");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.body).toContain("<title>Factory</title>");
    expect(page.body).toContain("color-scheme:light");
    expect(page.body).toContain("/api/factory/cards");
    expect(page.body).toContain("factory.card");
    expect(page.body).not.toMatch(/https?:\/\/[a-z]/);
    expect(page.body).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});
