import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceConfig } from "../../config/types.voice.js";
import type { GatewayRequestContext, GatewayRequestHandler, RespondFn } from "./types.js";
import { APPROVAL_METHODS, voiceApprovalRefusal } from "../../voice/approval-guard.js";
import { resolveVoiceConfig } from "../../voice/config.js";
import { VoiceManager } from "../../voice/manager.js";
import { setVoiceManagerForTests } from "../../voice/runtime.js";
import { resolveEventSchemaName, resolveMethodSchemaNames } from "../protocol/json-schema.js";
import { BASE_GATEWAY_METHODS, GATEWAY_EVENTS } from "../server-methods-list.js";
import { coreGatewayHandlers, handleGatewayRequest } from "../server-methods.js";

type Reply = { ok: boolean; payload?: unknown; error?: { message: string } };

function client(scopes: string[], connId = "conn-1") {
  return {
    connId,
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "work-console", version: "1", platform: "test", mode: "ui" },
      role: "operator",
      scopes,
    },
  } as never;
}

async function call(
  method: string,
  params: Record<string, unknown>,
  opts: { scopes?: string[]; extra?: Record<string, GatewayRequestHandler> } = {},
): Promise<Reply> {
  let reply: Reply | null = null;
  const respond: RespondFn = (ok, payload, error) => {
    reply = { ok, payload, error: error as Reply["error"] };
  };
  await handleGatewayRequest({
    req: { type: "req", id: "1", method, params },
    respond,
    client: client(opts.scopes ?? ["operator.admin"]),
    isWebchatConnect: () => false,
    context: {} as GatewayRequestContext,
    extraHandlers: opts.extra,
  });
  if (!reply) {
    throw new Error("no reply");
  }
  return reply;
}

describe("approval methods never accept a voice origin", () => {
  const voiceMarkers: Array<Record<string, unknown>> = [
    { origin: "voice" },
    { inputMode: "speech" },
    { source: "voice.transcript" },
    { voice: true },
    { voiceSessionId: "abc" },
    { fromVoice: 1 },
    { meta: { origin: "voice" } },
    { context: { spoken: true } },
  ];

  it.each([...APPROVAL_METHODS])("%s refuses every voice marker before its handler", async (m) => {
    const spy = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ran: true }));
    for (const marker of voiceMarkers) {
      const reply = await call(
        m,
        { id: "x", decision: "allow-once", ...marker },
        { extra: { [m]: spy } },
      );
      expect(reply.ok).toBe(false);
      expect(reply.error?.message).toMatch(/cannot be approved by voice/);
    }
    expect(spy).not.toHaveBeenCalled();
    // The same call without a marker reaches the handler.
    const ok = await call(m, { id: "x", decision: "allow-once" }, { extra: { [m]: spy } });
    expect(ok.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("every guarded approval method is a real gateway method", () => {
    for (const m of APPROVAL_METHODS) {
      expect(BASE_GATEWAY_METHODS, m).toContain(m);
    }
    expect(coreGatewayHandlers["pair.approve"]).toBeTypeOf("function");
  });

  it("matches future approve-type names and ignores payload data deeper down", () => {
    expect(voiceApprovalRefusal("factory.card.approve", { via: "voice" })).toMatch(/voice/);
    expect(
      voiceApprovalRefusal("exec.approvals.set", {
        file: { version: 1, agents: { voice: { security: "allowlist" } } },
      }),
    ).toBeNull();
    expect(voiceApprovalRefusal("chat.send", { origin: "voice" })).toBeNull();
    expect(voiceApprovalRefusal("exec.approval.resolve", { voice: false })).toBeNull();
  });
});

describe("voice.* gateway methods", () => {
  const sent: Array<{ connId: string; event: string; payload: unknown }> = [];
  let cfg: VoiceConfig;

  beforeEach(() => {
    sent.length = 0;
    cfg = { enabled: true, stt: { adapter: "fake" }, tts: { adapter: "fake" } };
    setVoiceManagerForTests(
      new VoiceManager({
        config: () => resolveVoiceConfig(cfg),
        sink: () => (connId, event, payload) => sent.push({ connId, event, payload }),
        audit: () => {},
      }),
    );
  });
  afterEach(() => setVoiceManagerForTests(null));

  it("runs start → audio → stop and returns the final transcript", async () => {
    const start = await call("voice.start", { lang: "en", projectId: "p1" });
    expect(start.ok).toBe(true);
    const { sessionId } = start.payload as { sessionId: string };
    const chunk = Buffer.alloc(640).toString("base64");
    expect((await call("voice.audio", { sessionId, chunk, seq: 0 })).ok).toBe(true);
    const stop = await call("voice.stop", { sessionId });
    expect(stop.payload).toMatchObject({ sessionId, text: "please", lang: "en" });
    expect(sent.map((e) => e.event)).toEqual([
      "voice.transcript.partial",
      "voice.transcript.final",
    ]);
    expect(sent.every((e) => e.connId === "conn-1")).toBe(true);
  });

  it("validates params against the protocol schema", async () => {
    const bad = await call("voice.start", { lang: "fr" });
    expect(bad.ok).toBe(false);
    expect(bad.error?.message).toMatch(/invalid voice.start params/);
    const extra = await call("voice.stop", { sessionId: "s", approve: true });
    expect(extra.ok).toBe(false);
  });

  it("needs write (attach) scope and is unavailable while disabled", async () => {
    const readOnly = await call("voice.start", {}, { scopes: ["operator.read"] });
    expect(readOnly.error?.message).toMatch(/missing scope: operator.write/);
    cfg.enabled = false;
    const off = await call("voice.start", {});
    expect(off.ok).toBe(false);
    expect(off.error?.message).toMatch(/not enabled/);
  });

  it("is documented: methods, events and their schemas resolve for the OpenAPI document", () => {
    for (const m of ["voice.start", "voice.audio", "voice.stop", "voice.speak", "voice.cancel"]) {
      expect(BASE_GATEWAY_METHODS).toContain(m);
      expect(resolveMethodSchemaNames(m).params).toBeTruthy();
      expect(resolveMethodSchemaNames(m).result).toBeTruthy();
    }
    for (const e of [
      "voice.transcript.partial",
      "voice.transcript.final",
      "voice.audio.out",
      "voice.session.ended",
    ]) {
      expect(GATEWAY_EVENTS).toContain(e);
      expect(resolveEventSchemaName(e)).toBeTruthy();
    }
  });
});
