import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway";
import { emptyBusiness, resetBusiness, type BusinessHost } from "./business";
import {
  acknowledgeBusinessWorkOutcome,
  beginBusinessWork,
  cancelBusinessWork,
  createBusinessWork,
  editBusinessWork,
  resetBusinessWorkState,
} from "./business-work-intake";
import { DEFAULT_PROJECTS_STATE } from "./projects";

function fixture() {
  const item = { id: "created", projectId: "p1", queue: "office", type: "request" };
  const config = {
    queues: [{ id: "office", types: ["request", "case"], name: { en: "Office" } }],
    error: null,
  };
  const request = vi
    .fn()
    .mockImplementation(async (method: string) =>
      method === "workitems.config"
        ? config
        : method === "workitems.list"
          ? { items: [], counts: {}, total: 0, nextCursor: null }
          : { item },
    );
  const h: BusinessHost = {
    business: {
      ...emptyBusiness(),
      projectId: "p1",
      queue: "office",
      config: config as unknown as BusinessHost["business"]["config"],
    },
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    tab: "projects",
    projects: { ...DEFAULT_PROJECTS_STATE, selectedId: "p1", view: "business" },
  };
  beginBusinessWork(h);
  editBusinessWork(h, {
    title: " Visitor access ",
    requester: " Office team ",
    description: " Reception preparation ",
  });
  return { h, request, item };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("generic business work intake", () => {
  it("sends existing Project file references for a document request", async () => {
    const { h, request, item } = fixture();
    h.business.config!.queues[0].types = ["document"];
    editBusinessWork(h, {
      type: "document",
      documents: " requests/brief.pdf \n\n references/契約.txt ",
    });
    request.mockResolvedValueOnce({ item: { ...item, type: "document" } });
    await createBusinessWork(h);
    expect(request).toHaveBeenCalledWith("workitems.create", {
      projectId: "p1",
      queue: "office",
      type: "document",
      title: "Visitor access",
      source: {
        fields: { description: "Reception preparation", requester: "Office team" },
        documents: [
          { kind: "file", ref: "requests/brief.pdf" },
          { kind: "file", ref: "references/契約.txt" },
        ],
      },
    });
  });
  it.each([
    "../secret",
    "/etc/passwd",
    "C:/private",
    "folder/../private",
    "folder//file",
    "./file",
    "folder/",
    "folder\\file",
    "bad\u0000file",
    Array.from({ length: 51 }, (_, i) => `file${i}`).join("\n"),
  ])("refuses unsafe or excessive existing-file references (%s)", async (documents) => {
    const { h, request } = fixture();
    editBusinessWork(h, { documents });
    await createBusinessWork(h);
    expect(request).not.toHaveBeenCalled();
  });

  it("creates only an explicit request with configured type and refreshes its real detail", async () => {
    const { h, request } = fixture();
    expect(request).not.toHaveBeenCalled();
    await createBusinessWork(h);
    expect(request).toHaveBeenCalledWith("workitems.create", {
      projectId: "p1",
      queue: "office",
      type: "request",
      title: "Visitor access",
      source: { fields: { description: "Reception preparation", requester: "Office team" } },
    });
    expect(request.mock.calls.filter(([method]) => method === "workitems.create")).toHaveLength(1);
    expect(h.business.selectedId).toBe("created");
    expect(h.business.workForm).toBeNull();
    expect(h.business.workPending).toBe(false);
    expect(h.business.workNotice).toBeTruthy();
  });
  it("pins the selected queue and refuses unsupported types", async () => {
    const { h, request } = fixture();
    const before = h.business.workForm;
    editBusinessWork(h, { type: "invoice" });
    editBusinessWork(h, { queue: "other" });
    expect(h.business.workForm).toBe(before);
    h.business.workForm = { ...before!, type: "invoice" };
    await createBusinessWork(h);
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects blank inputs and a queue removed from configuration", async () => {
    const { h, request } = fixture();
    editBusinessWork(h, { title: " " });
    await createBusinessWork(h);
    editBusinessWork(h, { title: "Title" });
    h.business.config = { ...h.business.config!, queues: [] };
    await createBusinessWork(h);
    expect(request).not.toHaveBeenCalled();
  });
  it("blocks double submit, cancel and form edits while the create is unresolved", async () => {
    const { h, request, item } = fixture();
    const wait = deferred();
    request.mockImplementationOnce(() => wait.promise);
    const pending = createBusinessWork(h);
    const form = h.business.workForm;
    await createBusinessWork(h);
    cancelBusinessWork(h);
    editBusinessWork(h, { title: "Changed" });
    expect(h.business.workForm).toBe(form);
    expect(request).toHaveBeenCalledTimes(1);
    wait.resolve({ item });
    await pending;
  });
  it("retains uncertain outcomes across project resets, with no automatic retry", async () => {
    const { h, request } = fixture();
    request.mockRejectedValueOnce(new Error("private transport details"));
    await createBusinessWork(h);
    expect(h.business.workUncertain).toBe(true);
    expect(h.business.workNotice).not.toContain("private");
    beginBusinessWork(h);
    await createBusinessWork(h);
    expect(request).toHaveBeenCalledTimes(1);
    h.projects.selectedId = "p2";
    resetBusiness(h);
    resetBusinessWorkState(h);
    expect(h.business.workUncertain).toBe(false);
    h.projects.selectedId = "p1";
    resetBusiness(h);
    resetBusinessWorkState(h);
    expect(h.business.workUncertain).toBe(true);
    h.business = {
      ...h.business,
      projectId: "p1",
      config: { queues: [], error: null } as unknown as BusinessHost["business"]["config"],
    };
    acknowledgeBusinessWorkOutcome(h);
    expect(h.business.workUncertain).toBe(false);
  });
  it("does not inject a successful result into a different project or client", async () => {
    const { h, request, item } = fixture();
    const wait = deferred();
    request.mockImplementationOnce(() => wait.promise);
    const pending = createBusinessWork(h);
    h.projects.selectedId = "p2";
    h.client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    resetBusiness(h);
    resetBusinessWorkState(h);
    expect(h.business.workPending).toBe(true);
    wait.resolve({ item });
    await pending;
    expect(h.business.selectedId).toBeNull();
    expect(h.business.workPending).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("remembers delayed failures for their originating project only", async () => {
    const { h, request } = fixture();
    const wait = deferred();
    request.mockImplementationOnce(() => wait.promise);
    const pending = createBusinessWork(h);
    h.projects.selectedId = "p2";
    resetBusiness(h);
    resetBusinessWorkState(h);
    wait.reject(new Error("timeout"));
    await pending;
    expect(h.business.workUncertain).toBe(false);
    h.projects.selectedId = "p1";
    resetBusiness(h);
    resetBusinessWorkState(h);
    expect(h.business.workUncertain).toBe(true);
  });
  it("treats a mismatched create response as uncertain", async () => {
    const { h, request, item } = fixture();
    request.mockResolvedValueOnce({ item: { ...item, queue: "other" } });
    await createBusinessWork(h);
    expect(h.business.workUncertain).toBe(true);
    expect(h.business.selectedId).toBeNull();
  });
  it.each(["decisionPending", "expensePending", "expenseUncertain"] as const)(
    "blocks creation during %s",
    async (flag) => {
      const { h, request } = fixture();
      h.business[flag] = true;
      await createBusinessWork(h);
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("does not open with no selected queue or outside the business workspace", () => {
    const { h } = fixture();
    cancelBusinessWork(h);
    h.business.queue = "";
    beginBusinessWork(h);
    expect(h.business.workForm).toBeNull();
    h.business.queue = "office";
    h.connected = false;
    beginBusinessWork(h);
    expect(h.business.workForm).toBeNull();
  });
});

it("blocks work creation while a report form is open", async () => {
  const { h, request } = fixture();
  h.business.reportForm = { id: "a", revision: 1, reason: "Wrong amount" };
  await createBusinessWork(h);
  expect(request).not.toHaveBeenCalled();
  cancelBusinessWork(h);
  beginBusinessWork(h);
  expect(h.business.workForm).toBeNull();
});
