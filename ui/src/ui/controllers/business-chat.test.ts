import { describe, expect, it, vi } from "vitest";
import type { KoLoApp } from "../app";
import { emptyBusiness } from "./business";
import { departmentOfChat, startBusinessChat } from "./business-chat";

const projectId = "p1234567890";
const financeKey = `agent:finance-agent:proj-${projectId}-deptfinance0abc123`;
function setup() {
  const request = vi.fn().mockResolvedValue({ sessionKey: financeKey });
  const send = vi.fn().mockResolvedValue(undefined);
  const open = vi.fn((key: string) => {
    host.sessionKey = key;
    host.tab = "chat";
  });
  const host = {
    connected: true,
    client: { request },
    locale: "en",
    tab: "projects",
    sessionKey: "agent:main:main",
    projects: {
      selectedId: projectId,
      view: "business",
      projects: [
        {
          id: projectId,
          allowedAgents: [],
          archived: false,
          templateId: "business-company-operations",
        },
      ],
    },
    business: {
      ...emptyBusiness(),
      projectId,
      department: "finance",
      config: { queues: [{ id: "finance-work", department: "finance" }] },
    },
    businessChatOpening: false,
    businessChatError: null,
    businessChatDraft: "Help me prepare the monthly close",
    chatMessage: "",
    chatQueue: [],
    chatAttachments: [],
    chatRunId: null,
    chatSending: false,
    uploads: { documents: [] },
    updateComplete: Promise.resolve(),
    renderRoot: { querySelector: vi.fn() },
    openChatSession: open,
    handleSendChat: send,
    refreshChatHistoryPanel: vi.fn(),
  } as unknown as KoLoApp;
  return { host, request, open, send };
}

describe("department conversations", () => {
  it("restores validated department context from a project session only", () => {
    expect(departmentOfChat(financeKey)?.id).toBe("finance");
    expect(departmentOfChat("agent:main:deptfinance0abc")).toBeUndefined();
    expect(departmentOfChat(`agent:main:proj-${projectId}-deptunknown0abc`)).toBeUndefined();
    expect(departmentOfChat(`agent:main:proj-${projectId}-ordinary123`)).toBeUndefined();
  });
  it("opens the server-routed department session and sends only the user's text", async () => {
    const { host, request, open, send } = setup();
    await startBusinessChat(host, projectId, host.businessChatDraft);
    expect(request).toHaveBeenCalledWith("projects.chatKey", {
      id: projectId,
      departmentId: "finance",
    });
    expect(open).toHaveBeenCalledWith(financeKey);
    expect(host.chatMessage).toBe("Help me prepare the monthly close");
    expect(send).toHaveBeenCalledOnce();
    expect(host.businessChatDraft).toBe("");
    expect(host.businessChatOpening).toBe(false);
  });
  it("can open a blank conversation without sending a synthetic message", async () => {
    const { host, open, send } = setup();
    await startBusinessChat(host, projectId);
    expect(open).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("Help me prepare the monthly close");
  });
  it("does not replace a previous unsent chat draft", async () => {
    const { host, request } = setup();
    host.chatMessage = "Existing draft";
    await startBusinessChat(host, projectId, "New text");
    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("Existing draft");
    expect(host.businessChatError).toContain("unsent draft");
  });
  it("ignores a resolved key after project navigation", async () => {
    const { host, request, open, send } = setup();
    let resolve!: (result: { sessionKey: string }) => void;
    request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const opening = startBusinessChat(host, projectId, "Hello");
    host.projects.selectedId = "p9876543210";
    resolve({ sessionKey: financeKey });
    await opening;
    expect(open).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it("does not open mismatched department or project responses", async () => {
    const { host, request, open } = setup();
    request.mockResolvedValue({ sessionKey: financeKey.replace("deptfinance", "depthr") });
    await startBusinessChat(host, projectId, "Hello");
    expect(open).not.toHaveBeenCalled();
    expect(host.businessChatError).toContain("verified");
  });
  it("retains draft and exposes gateway failures", async () => {
    const { host, request } = setup();
    request.mockRejectedValue(new Error("Agent unavailable"));
    await startBusinessChat(host, projectId, host.businessChatDraft);
    expect(host.businessChatError).toContain("Agent unavailable");
    expect(host.businessChatDraft).toBe("Help me prepare the monthly close");
  });
  it("rejects duplicate openings and does not cross active work forms", async () => {
    const { host, request } = setup();
    host.businessChatOpening = true;
    await startBusinessChat(host, projectId);
    expect(request).not.toHaveBeenCalled();
    host.businessChatOpening = false;
    host.business.workPending = true;
    await startBusinessChat(host, projectId);
    expect(request).not.toHaveBeenCalled();
  });
  it("refuses unconfigured departments before starting", async () => {
    const { host, request } = setup();
    host.business.department = "hr";
    await startBusinessChat(host, projectId);
    expect(request).not.toHaveBeenCalled();
    expect(host.businessChatError).toContain("not configured");
  });
});
