import { describe, expect, it, vi } from "vitest";
import {
  handleChatEvent,
  loadChatHistory,
  sendChatMessage,
  type ChatEventPayload,
  type ChatState,
} from "./chat";

function createState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    client: null,
    connected: true,
    sessionKey: "main",
    chatLoading: false,
    chatMessages: [],
    chatAttachments: [],
    chatStreamReasoning: null,
    chatThinkingLevel: null,
    chatSending: false,
    chatMessage: "",
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    lastError: null,
    ...overrides,
  };
}

describe("handleChatEvent", () => {
  it("returns null when payload is missing", () => {
    const state = createState();
    expect(handleChatEvent(state, undefined)).toBe(null);
  });

  it("returns null when sessionKey does not match", () => {
    const state = createState({ sessionKey: "main" });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "other",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe(null);
  });

  it("returns null for delta from another run", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Hello",
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    };
    expect(handleChatEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Hello");
  });

  it("returns 'final' for final from another run (e.g. sub-agent announce) without clearing state", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Working...",
      chatStreamStartedAt: 123,
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Sub-agent findings" }],
      },
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
  });

  it("processes final from own run and clears state", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Reply",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
  });
});

describe("handleChatEvent reasoning", () => {
  it("keeps live reasoning apart from the answer and clears it on final", () => {
    const state = createState({ sessionKey: "main", chatRunId: "run-1", chatStream: "" });
    handleChatEvent(state, {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
      reasoning: { text: "Check the config", state: "streaming" },
    });
    expect(state.chatStreamReasoning).toEqual({ text: "Check the config", state: "streaming" });
    expect(state.chatStream).toBe("");
    handleChatEvent(state, {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "Port 18789." }] },
      reasoning: { text: "Check the config", state: "done", durationMs: 12_000 },
    });
    expect(state.chatStream).toBe("Port 18789.");
    expect(state.chatStreamReasoning).toEqual({
      text: "Check the config",
      state: "done",
      durationMs: 12_000,
    });
    handleChatEvent(state, { runId: "run-1", sessionKey: "main", state: "final" });
    expect(state.chatStreamReasoning).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function requestClient(request: ReturnType<typeof vi.fn>): NonNullable<ChatState["client"]> {
  return { request } as unknown as NonNullable<ChatState["client"]>;
}

describe("chat request isolation", () => {
  it("keeps newer history when requests complete out of order", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const state = createState({
      client: requestClient(
        vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
      ),
    });
    const old = loadChatHistory(state);
    const current = loadChatHistory(state);
    first.resolve({ messages: ["old"] });
    await old;
    expect(state.chatLoading).toBe(true);
    expect(state.chatMessages).toEqual([]);
    second.resolve({ messages: ["new"], thinkingLevel: "high" });
    await current;
    expect(state.chatMessages).toEqual(["new"]);
    expect(state.chatThinkingLevel).toBe("high");
    expect(state.chatLoading).toBe(false);
  });

  it.each(["session", "client"])("ignores history results after changing %s", async (change) => {
    const reply = deferred<unknown>();
    const state = createState({ client: requestClient(vi.fn().mockReturnValue(reply.promise)) });
    const pending = loadChatHistory(state);
    if (change === "session") {
      state.sessionKey = "other";
    } else {
      state.client = requestClient(vi.fn());
    }
    state.chatMessages = ["current department"];
    state.chatLoading = true;
    reply.resolve({ messages: ["private old history"] });
    await pending;
    expect(state.chatMessages).toEqual(["current department"]);
    expect(state.chatLoading).toBe(true);
  });

  it("ignores a stale history failure and its loading cleanup", async () => {
    const reply = deferred<unknown>();
    const state = createState({ client: requestClient(vi.fn().mockReturnValue(reply.promise)) });
    const pending = loadChatHistory(state);
    state.sessionKey = "other";
    state.lastError = "current error";
    reply.reject(new Error("old department error"));
    await pending;
    expect(state.lastError).toBe("current error");
    expect(state.chatLoading).toBe(true);
  });

  it("does not overwrite an optimistic message with pre-send history", async () => {
    const history = deferred<unknown>();
    const sent = deferred<unknown>();
    const state = createState({
      client: requestClient(
        vi.fn().mockReturnValueOnce(history.promise).mockReturnValueOnce(sent.promise),
      ),
    });
    const oldHistory = loadChatHistory(state);
    const pendingSend = sendChatMessage(state, "New question");
    const optimistic = state.chatMessages;
    history.resolve({ messages: ["stale"] });
    await oldHistory;
    expect(state.chatMessages).toBe(optimistic);
    expect(state.chatLoading).toBe(false);
    sent.resolve({});
    expect(await pendingSend).toBe(state.chatRunId);
    expect(state.chatSending).toBe(false);
  });

  it("ignores a late send failure after switching conversations", async () => {
    const sent = deferred<unknown>();
    const state = createState({ client: requestClient(vi.fn().mockReturnValue(sent.promise)) });
    const pending = sendChatMessage(state, "Old department question");
    state.sessionKey = "other";
    state.chatRunId = "new-run";
    state.chatStream = "new answer";
    state.chatMessages = ["new conversation"];
    sent.reject(new Error("old failure"));
    expect(await pending).toBeNull();
    expect(state.chatMessages).toEqual(["new conversation"]);
    expect(state.chatStream).toBe("new answer");
    expect(state.chatRunId).toBe("new-run");
    expect(state.chatSending).toBe(true);
    expect(state.lastError).toBeNull();
  });

  it("does not clear a newer send in the same conversation", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const state = createState({
      client: requestClient(
        vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
      ),
    });
    const old = sendChatMessage(state, "First");
    const current = sendChatMessage(state, "Second");
    const newRun = state.chatRunId;
    first.reject(new Error("old failure"));
    expect(await old).toBeNull();
    expect(state.chatRunId).toBe(newRun);
    expect(state.chatSending).toBe(true);
    expect(state.lastError).toBeNull();
    second.resolve({});
    expect(await current).toBe(newRun);
    expect(state.chatSending).toBe(false);
  });

  it("clears sending when a final event arrives before the send acknowledgement", async () => {
    const sent = deferred<unknown>();
    const state = createState({ client: requestClient(vi.fn().mockReturnValue(sent.promise)) });
    const pending = sendChatMessage(state, "Question");
    const runId = state.chatRunId!;
    handleChatEvent(state, { sessionKey: state.sessionKey, runId, state: "final" });
    sent.resolve({});
    expect(await pending).toBe(runId);
    expect(state.chatSending).toBe(false);
  });
});
