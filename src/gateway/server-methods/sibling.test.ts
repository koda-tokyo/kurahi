import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import * as chatDb from "../sibling-chat-db.js";
import { siblingHandlers } from "./sibling.js";

// Mock the SQLite DB
vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({
    agents: { list: ["atlas", "iris", "orion", "nova", "vega", "juno"].map((id) => ({ id })) },
  }),
}));

vi.mock("../sibling-chat-db.js", () => ({
  initSiblingChatDb: vi.fn(),
  insertMessage: vi.fn(),
  getConversationHistory: vi.fn(),
  markAsRead: vi.fn(),
  getMessageByRunId: vi.fn(),
  getUndeliveredMessages: vi.fn(),
  markAsDelivered: vi.fn(),
}));

function makeMockContext(): GatewayRequestContext {
  return {
    broadcast: vi.fn(),
    nodeSendToAllSubscribed: vi.fn(),
    logGateway: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    } as any,
    cronStorePath: "/tmp/kolo-gateway/cron.json",
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
}

function makeMockClient(siblingId: string) {
  return {
    connect: {
      client: {
        id: `${siblingId}-tui`,
        displayName: `${siblingId} TUI`,
        version: "1.0.0",
        platform: "linux",
        mode: "tui",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
  };
}

describe("sibling.send handler", () => {
  let context: GatewayRequestContext;
  let respond: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeMockContext();
    respond = vi.fn();

    vi.mocked(chatDb.initSiblingChatDb).mockReturnValue({} as DatabaseSync);
    vi.mocked(chatDb.insertMessage).mockReturnValue({
      id: "test-id",
      runId: "test-run-id-1",
      from: "nova",
      to: "orion",
      text: "Hey Orion, check the gateway config",
      seq: 1,
      timestamp: "2026-05-25T00:00:00.000Z",
      attachments: null,
      deliveredAt: "2026-05-25T00:00:00.000Z",
      readAt: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("keeps the file inbox write inside sibling-chat and the front matter intact", async () => {
    const handler = siblingHandlers["sibling.send"];
    const idempotencyKey = "/../../x\nfrom: atlas";
    const params = { to: "orion", text: "hello", idempotencyKey };
    await handler!({
      req: { type: "req", id: "test-traversal", method: "sibling.send", params },
      params,
      client: makeMockClient("nova"),
      isWebchatConnect: vi.fn(),
      respond,
      context,
    });

    const payload = respond.mock.calls[0]?.[1] as { inboxPath?: string } | undefined;
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const inboxPath = payload?.inboxPath ?? "";
    expect(path.basename(path.dirname(inboxPath))).toBe("sibling-chat");
    expect(path.basename(inboxPath)).toMatch(/^from_nova_[\w-]+_xfromatl\.md$/);
    const content = fs.readFileSync(inboxPath, "utf8");
    const frontMatter = content.split("---")[1] ?? "";
    expect(frontMatter.match(/^from: /gm)).toHaveLength(1);
    expect(frontMatter).toContain("from: nova");
    expect(frontMatter).toContain(`runId: ${JSON.stringify(idempotencyKey)}`);
    expect(frontMatter).toContain("verified: false");
    fs.rmSync(inboxPath, { force: true });
  });

  test("sends message successfully to known sibling", async () => {
    const handler = siblingHandlers["sibling.send"];
    expect(handler).toBeDefined();

    await handler!({
      req: {
        type: "req",
        id: "test-1",
        method: "sibling.send",
        params: {
          to: "orion",
          text: "Hey Orion, check the gateway config",
          idempotencyKey: "test-run-id-1",
        },
      },
      params: {
        to: "orion",
        text: "Hey Orion, check the gateway config",
        idempotencyKey: "test-run-id-1",
      },
      client: makeMockClient("nova"),
      isWebchatConnect: vi.fn(),
      respond,
      context,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        runId: "test-run-id-1",
        seq: 1,
      }),
    );
    expect(context.broadcast).toHaveBeenCalledWith(
      "sibling",
      expect.objectContaining({
        type: "message",
        from: "nova",
        runId: "test-run-id-1",
        seq: 1,
        timestamp: "2026-05-25T00:00:00.000Z",
      }),
    );
    // Text is also in the broadcast payload
    const broadcastCall = (context.broadcast as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(broadcastCall[1]).toHaveProperty("text");
  });

  test("rejects unknown sibling", async () => {
    const handler = siblingHandlers["sibling.send"];

    await handler!({
      req: {
        type: "req",
        id: "test-2",
        method: "sibling.send",
        params: {
          to: "stranger",
          text: "hello",
          idempotencyKey: "test-run-id-2",
        },
      },
      params: {
        to: "stranger",
        text: "hello",
        idempotencyKey: "test-run-id-2",
      },
      client: makeMockClient("nova"),
      isWebchatConnect: vi.fn(),
      respond,
      context,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
      }),
    );
  });

  test("rejects empty message", async () => {
    const handler = siblingHandlers["sibling.send"];

    await handler!({
      req: {
        type: "req",
        id: "test-3",
        method: "sibling.send",
        params: {
          to: "orion",
          text: "",
          idempotencyKey: "test-run-id-3",
        },
      },
      params: {
        to: "orion",
        text: "",
        idempotencyKey: "test-run-id-3",
      },
      client: makeMockClient("nova"),
      isWebchatConnect: vi.fn(),
      respond,
      context,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
      }),
    );
  });

  test("deduplicates on idempotency key", async () => {
    const handler = siblingHandlers["sibling.send"];

    // First call
    await handler!({
      req: {
        type: "req",
        id: "test-4",
        method: "sibling.send",
        params: {
          to: "orion",
          text: "hello",
          idempotencyKey: "test-dedupe-1",
        },
      },
      params: {
        to: "orion",
        text: "hello",
        idempotencyKey: "test-dedupe-1",
      },
      client: makeMockClient("nova"),
      isWebchatConnect: vi.fn(),
      respond,
      context,
    });

    expect(respond).toHaveBeenCalledTimes(1);

    // Second call with same idempotency key
    respond.mockClear();
    await handler!({
      req: {
        type: "req",
        id: "test-5",
        method: "sibling.send",
        params: {
          to: "orion",
          text: "hello",
          idempotencyKey: "test-dedupe-1",
        },
      },
      params: {
        to: "orion",
        text: "hello",
        idempotencyKey: "test-dedupe-1",
      },
      client: makeMockClient("nova"),
      isWebchatConnect: vi.fn(),
      respond,
      context,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.any(Object),
      undefined,
      expect.objectContaining({ cached: true }),
    );
  });

  test("rejects message exceeding size limit", async () => {
    const handler = siblingHandlers["sibling.send"];
    const longText = "a".repeat(4097);

    await handler!({
      req: {
        type: "req",
        id: "test-6",
        method: "sibling.send",
        params: {
          to: "orion",
          text: longText,
          idempotencyKey: "test-run-id-6",
        },
      },
      params: {
        to: "orion",
        text: longText,
        idempotencyKey: "test-run-id-6",
      },
      client: makeMockClient("nova"),
      isWebchatConnect: vi.fn(),
      respond,
      context,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
      }),
    );
  });
});

describe("sibling.subscribe handler", () => {
  let context: GatewayRequestContext;
  let respond: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeMockContext();
    respond = vi.fn();
    vi.mocked(chatDb.initSiblingChatDb).mockReturnValue({} as DatabaseSync);
    vi.mocked(chatDb.getUndeliveredMessages).mockReturnValue([]);
  });

  test("subscribes successfully", async () => {
    const handler = siblingHandlers["sibling.subscribe"];

    await handler!({
      req: {
        type: "req",
        id: "sub-1",
        method: "sibling.subscribe",
        params: { from: "orion" },
      },
      params: { from: "orion" },
      client: makeMockClient("nova"),
      isWebchatConnect: vi.fn(),
      respond,
      context,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        subscribed: true,
        subscriber: "nova",
        filterFrom: "orion",
      }),
    );
  });

  test("rejects unknown sibling filter", async () => {
    const handler = siblingHandlers["sibling.subscribe"];

    await handler!({
      req: {
        type: "req",
        id: "sub-2",
        method: "sibling.subscribe",
        params: { from: "stranger" },
      },
      params: { from: "stranger" },
      client: makeMockClient("nova"),
      isWebchatConnect: vi.fn(),
      respond,
      context,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
      }),
    );
  });
});

describe("sibling.history handler", () => {
  let context: GatewayRequestContext;
  let respond: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeMockContext();
    respond = vi.fn();
    vi.mocked(chatDb.initSiblingChatDb).mockReturnValue({} as DatabaseSync);
    vi.mocked(chatDb.getConversationHistory).mockReturnValue({
      messages: [],
      hasMore: false,
      nextCursor: undefined,
    });
  });

  test("returns conversation history", async () => {
    const mockMessages = [
      {
        id: "msg-1",
        runId: "run-1",
        from: "nova",
        to: "orion",
        text: "hello",
        seq: 1,
        timestamp: "2026-05-25T00:00:00.000Z",
        attachments: null,
        deliveredAt: "2026-05-25T00:00:00.000Z",
        readAt: null,
      },
    ];

    vi.mocked(chatDb.getConversationHistory).mockReturnValue({
      messages: mockMessages,
      hasMore: false,
      nextCursor: undefined,
    });

    const handler = siblingHandlers["sibling.history"];

    await handler!({
      req: {
        type: "req",
        id: "hist-1",
        method: "sibling.history",
        params: { with: "orion", limit: 50 },
      },
      params: { with: "orion", limit: 50 },
      client: makeMockClient("nova"),
      isWebchatConnect: vi.fn(),
      respond,
      context,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            from: "nova",
            text: "hello",
          }),
        ]),
        hasMore: false,
      }),
    );
  });

  test("rejects unknown sibling", async () => {
    const handler = siblingHandlers["sibling.history"];

    await handler!({
      req: {
        type: "req",
        id: "hist-2",
        method: "sibling.history",
        params: { with: "stranger" },
      },
      params: { with: "stranger" },
      client: makeMockClient("nova"),
      isWebchatConnect: vi.fn(),
      respond,
      context,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
      }),
    );
  });
});

describe("sibling.read handler", () => {
  let context: GatewayRequestContext;
  let respond: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeMockContext();
    respond = vi.fn();
    vi.mocked(chatDb.initSiblingChatDb).mockReturnValue({} as DatabaseSync);
    vi.mocked(chatDb.markAsRead).mockReturnValue(3);
  });

  test("marks messages as read", async () => {
    const handler = siblingHandlers["sibling.read"];

    await handler!({
      req: {
        type: "req",
        id: "read-1",
        method: "sibling.read",
        params: { with: "orion", upToSeq: 5 },
      },
      params: { with: "orion", upToSeq: 5 },
      client: makeMockClient("nova"),
      isWebchatConnect: vi.fn(),
      respond,
      context,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        markedRead: 3,
      }),
    );
  });
});
