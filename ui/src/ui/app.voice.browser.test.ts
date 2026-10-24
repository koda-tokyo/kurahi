import { describe, expect, it, vi } from "vitest";
import type { Project } from "./controllers/projects";
import { KoLoApp } from "./app";
import { cancelVoice, emptyVoice } from "./controllers/voice";
const project = { id: "p1", allowedAgents: [] } as unknown as Project;
function setup() {
  let resolve!: (value: { sessionKey: string }) => void;
  const pending = new Promise<{ sessionKey: string }>((r) => {
    resolve = r;
  });
  const request = vi.fn(() => pending);
  const host = {
    connected: true,
    client: { request },
    agentsList: null,
    chatMessage: "Existing draft",
    voice: { ...emptyVoice(), phase: "ready", projectId: "p1", text: "Private transcript" },
    openChatSession: vi.fn(),
  } as unknown as KoLoApp;
  return { host, request, resolve };
}
describe("voice draft handoff", () => {
  it("opens only an editable draft after an explicit action", async () => {
    const s = setup();
    const action = KoLoApp.prototype.useVoiceDraft.call(s.host, project);
    expect(s.host.chatMessage).toBe("Existing draft");
    s.resolve({ sessionKey: "project:p1:voice" });
    await action;
    expect(s.host.openChatSession).toHaveBeenCalledWith("project:p1:voice");
    expect(s.host.chatMessage).toBe("Private transcript");
    expect(s.request.mock.calls).toHaveLength(1);
    expect(s.request).toHaveBeenCalledWith("projects.chatKey", { id: "p1", agentId: "main" });
  });
  it.each(["cancel", "disconnect", "edit"])(
    "does not restore a transcript after %s during chat creation",
    async (reason) => {
      const s = setup();
      const action = KoLoApp.prototype.useVoiceDraft.call(s.host, project);
      if (reason === "cancel") {
        cancelVoice(s.host);
      }
      if (reason === "disconnect") {
        s.host.connected = false;
      }
      if (reason === "edit") {
        s.host.voice = { ...s.host.voice, text: "Changed" };
      }
      s.resolve({ sessionKey: "project:p1:voice" });
      await action;
      expect(s.host.openChatSession).not.toHaveBeenCalled();
      expect(s.host.chatMessage).toBe("Existing draft");
    },
  );
});
