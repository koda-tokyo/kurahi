import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushChatQueueForEvent } from "./app-chat";
import { sendChatMessage } from "./controllers/chat";
vi.mock("./controllers/chat", () => ({
  sendChatMessage: vi.fn(),
  abortChatRun: vi.fn(),
  loadChatHistory: vi.fn(),
}));
vi.mock("./app-scroll", () => ({ scheduleChatScroll: vi.fn() }));
vi.mock("./app-tool-stream", () => ({ resetToolStream: vi.fn() }));
vi.mock("./app-settings", () => ({ setLastActiveSessionKey: vi.fn() }));
function setup() {
  const queued = { id: "queued-a", text: "Private finance question", createdAt: 1 };
  const host = {
    connected: true,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [queued],
    chatRunId: null,
    chatSending: false,
    sessionKey: "session-a",
    chatSessionGeneration: 0,
    basePath: "",
    hello: null,
    chatAvatarUrl: null,
    refreshSessionsAfterChat: new Set<string>(),
  } as Parameters<typeof flushChatQueueForEvent>[0];
  return { host, queued };
}
describe("queued conversation isolation", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([false, true])(
    "never requeues a previous conversation after switching (return=%s)",
    async (returnToOriginal) => {
      const { host } = setup();
      let done!: (id: string | null) => void;
      vi.mocked(sendChatMessage).mockImplementation(
        () =>
          new Promise((resolve) => {
            done = resolve;
          }),
      );
      const pending = flushChatQueueForEvent(host);
      host.sessionKey = "session-b";
      host.chatSessionGeneration = 1;
      host.chatQueue = [];
      if (returnToOriginal) {
        host.sessionKey = "session-a";
        host.chatSessionGeneration = 2;
      }
      done(null);
      await pending;
      expect(host.chatQueue).toEqual([]);
    },
  );
  it("keeps a failed queued message available in its original conversation", async () => {
    const { host, queued } = setup();
    vi.mocked(sendChatMessage).mockResolvedValue(null);
    await flushChatQueueForEvent(host);
    expect(host.chatQueue).toEqual([queued]);
  });
});
