import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";
import { signSiblingSendParams } from "../../agents/messaging/sibling.js";
import { flushAudit } from "../../audit/index.js";
import * as chatDb from "../sibling-chat-db.js";
import { resetSiblingDb, siblingHandlers } from "./sibling.js";

// sibling.send verifies a signed sender envelope (OWASP ASI07) according to
// agents.messaging.signing.mode.
const mocks = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
}));

vi.mock("../../config/config.js", () => ({ loadConfig: () => mocks.cfg }));
vi.mock("../sibling-chat-db.js", () => ({
  initSiblingChatDb: vi.fn(),
  insertMessage: vi.fn(),
  getConversationHistory: vi.fn(),
  markAsRead: vi.fn(),
  getMessageByRunId: vi.fn(),
  getUndeliveredMessages: vi.fn(),
  markAsDelivered: vi.fn(),
}));

const ROSTER = { list: ["atlas", "orion", "nova"].map((id) => ({ id })) };
const setMode = (mode: "off" | "warn" | "enforce") => {
  mocks.cfg = { agents: { ...ROSTER, messaging: { signing: { mode } } } };
};

let home = "";
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-sibling-sign-"));
  vi.stubEnv("KOLO_HOME", home);
  vi.stubEnv("KOLO_POLICY_OWNER_KEY_FILE", "");
});
afterAll(async () => {
  await flushAudit();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  resetSiblingDb();
  vi.mocked(chatDb.initSiblingChatDb).mockReturnValue({} as DatabaseSync);
  vi.mocked(chatDb.insertMessage).mockImplementation((_db, row) => ({
    id: "id",
    runId: row.runId,
    from: row.from,
    to: row.to,
    text: row.text,
    seq: 1,
    timestamp: "2026-10-23T00:00:00.000Z",
    attachments: null,
    deliveredAt: null,
    readAt: null,
  }));
});

async function send(params: Record<string, unknown>, clientId = "agent-tui") {
  const respond = vi.fn();
  const context = {
    broadcast: vi.fn(),
    nodeSendToAllSubscribed: vi.fn(),
    logGateway: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    cronStorePath: path.join(home, "cron.json"),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
  await siblingHandlers["sibling.send"]({
    params: { idempotencyKey: `idem-${Math.random()}`, ...params },
    respond,
    context,
    req: { type: "req", id: "1", method: "sibling.send" },
    client: { connect: { client: { id: clientId } } } as never,
    isWebchatConnect: () => false,
  });
  return { respond, context };
}

describe("sibling.send signing", () => {
  it("enforce: an unsigned send is refused", async () => {
    setMode("enforce");
    const { respond } = await send({ to: "orion", text: "hi" }, "nova-tui");
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringMatching(/sibling message rejected.*unsigned/),
      }),
    );
    expect(chatDb.insertMessage).not.toHaveBeenCalled();
  });

  it("enforce: a signed send is delivered with the verified sender, not the client id", async () => {
    setMode("enforce");
    const signed = signSiblingSendParams({
      cfg: mocks.cfg,
      fromAgentId: "nova",
      to: "orion",
      text: "check the config",
    });
    expect(signed.agentEnvelope).toBeDefined();
    const { respond, context } = await send({ to: "orion", text: "check the config", ...signed });
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }));
    expect(vi.mocked(chatDb.insertMessage).mock.calls[0]?.[1]).toMatchObject({ from: "nova" });
    expect(context.broadcast).toHaveBeenCalledWith(
      "sibling",
      expect.objectContaining({ from: "nova", verified: true }),
    );

    // The same envelope again (new idempotency key) is a replay.
    const replay = await send({ to: "orion", text: "check the config", ...signed });
    expect(replay.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringMatching(/replay/) }),
    );
  });

  it("enforce: an envelope made for another peer or with altered text is refused", async () => {
    setMode("enforce");
    const signed = signSiblingSendParams({
      cfg: mocks.cfg,
      fromAgentId: "nova",
      to: "orion",
      text: "for orion",
    });
    const misdirected = await send({ to: "atlas", text: "for orion", ...signed });
    expect(misdirected.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringMatching(/recipient-mismatch/) }),
    );
    const altered = signSiblingSendParams({
      cfg: mocks.cfg,
      fromAgentId: "nova",
      to: "orion",
      text: "original",
    });
    const tampered = await send({ to: "orion", text: "changed", ...altered });
    expect(tampered.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringMatching(/payload-mismatch/) }),
    );
  });

  it("warn: an unsigned send is delivered with the client-declared sender, marked unverified", async () => {
    setMode("warn");
    const { respond, context } = await send({ to: "orion", text: "hi" }, "nova-tui");
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }));
    expect(context.broadcast).toHaveBeenCalledWith(
      "sibling",
      expect.objectContaining({ from: "nova", verified: false }),
    );
    await flushAudit();
    const auditDir = path.join(home, "audit");
    const entries = fs
      .readdirSync(auditDir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => fs.readFileSync(path.join(auditDir, f), "utf8").trim().split("\n"))
      .map((line) => JSON.parse(line) as { action?: string; outcome?: string });
    expect(entries).toContainEqual(
      expect.objectContaining({ action: "sibling.message.verify", outcome: "flagged" }),
    );
  });

  it("off: no checks (the pre-signing behaviour)", async () => {
    setMode("off");
    const { respond } = await send({ to: "orion", text: "hi" }, "nova-tui");
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }));
  });
});
