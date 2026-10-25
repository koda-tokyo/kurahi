import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway";
import type { BusinessHost } from "./business";
import { emptyBusiness, loadBusinessItem, resetBusiness, selectBusinessQueue } from "./business";
import { loadBusinessDraft } from "./business-draft";
import { DEFAULT_PROJECTS_STATE } from "./projects";

async function fixture(content = "Invoice draft\n請求書") {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const sha256 = Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
  const item = {
    id: "i1",
    projectId: "p1",
    revision: 3,
    draft: { artifactId: "a1", version: 2, sha256 },
  } as NonNullable<BusinessHost["business"]["item"]>;
  const response = {
    artifact: { id: "a1", projectId: "p1", versions: [{ version: 2, sha256 }] },
    version: 2,
    content,
  };
  const request = vi.fn().mockResolvedValue(response);
  const host: BusinessHost = {
    business: { ...emptyBusiness(), projectId: "p1", selectedId: "i1", item },
    connected: true,
    tab: "projects",
    client: { request } as unknown as GatewayBrowserClient,
    projects: { ...DEFAULT_PROJECTS_STATE, selectedId: "p1", view: "business" },
  };
  return { host, request, response };
}

describe("Business pinned draft preview", () => {
  it("reads only the pinned version and matches UTF-8 bytes", async () => {
    const { host, request, response } = await fixture();
    await loadBusinessDraft(host);
    expect(request.mock.calls).toEqual([["artifacts.get", { id: "a1", version: 2 }]]);
    expect(host.business.draftPreview).toEqual({
      itemId: "i1",
      revision: 3,
      status: "ready",
      content: response.content,
    });
  });
  it("accepts an empty draft as content", async () => {
    const { host } = await fixture("");
    await loadBusinessDraft(host);
    expect(host.business.draftPreview?.status).toBe("ready");
    expect(host.business.draftPreview?.content).toBe("");
  });
  it.each(["project", "id", "version", "hash", "content", "missingVersion"])(
    "rejects mismatched %s",
    async (field) => {
      const { host, response } = await fixture();
      if (field === "project") {
        response.artifact.projectId = "p2";
      }
      if (field === "id") {
        response.artifact.id = "a2";
      }
      if (field === "version") {
        response.version = 3;
      }
      if (field === "hash") {
        response.artifact.versions[0].sha256 = "f".repeat(64);
      }
      if (field === "content") {
        response.content = "tampered";
      }
      if (field === "missingVersion") {
        response.artifact.versions = [];
      }
      await loadBusinessDraft(host);
      expect(host.business.draftPreview).toMatchObject({ status: "error", content: null });
    },
  );
  it("does not expose transport errors and permits an explicit retry", async () => {
    const { host, request, response } = await fixture();
    request.mockRejectedValueOnce(new Error("private backend path"));
    await loadBusinessDraft(host);
    expect(host.business.draftPreview).toMatchObject({ status: "error", content: null });
    request.mockResolvedValue(response);
    await loadBusinessDraft(host);
    expect(host.business.draftPreview?.status).toBe("ready");
  });
  it.each(["reset", "project", "item", "client", "disconnect"])(
    "discards delayed content after %s",
    async (change) => {
      const { host, request, response } = await fixture();
      let finish!: (value: typeof response) => void;
      request.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = loadBusinessDraft(host);
      await loadBusinessDraft(host);
      expect(request).toHaveBeenCalledTimes(1);
      if (change === "reset") {
        resetBusiness(host);
      }
      if (change === "project") {
        host.projects.selectedId = "p2";
      }
      if (change === "item") {
        host.business.item = { ...host.business.item!, revision: 4 };
      }
      if (change === "client") {
        host.client = {} as GatewayBrowserClient;
      }
      if (change === "disconnect") {
        host.connected = false;
      }
      finish(response);
      await pending;
      expect(host.business.draftPreview?.content ?? null).toBeNull();
    },
  );
  it("clears verified content when the item is refreshed or queue changes", async () => {
    const { host, request } = await fixture();
    await loadBusinessDraft(host);
    request.mockResolvedValue({ item: host.business.item });
    await loadBusinessItem(host, "i1", true);
    expect(host.business.draftPreview).toBeNull();
    request.mockRejectedValue(new Error("offline"));
    await selectBusinessQueue(host, "other");
    expect(host.business.draftPreview).toBeNull();
  });
  it("does not read while offline, another Project is selected, or item is loading", async () => {
    const { host, request } = await fixture();
    host.connected = false;
    await loadBusinessDraft(host);
    host.connected = true;
    host.projects.selectedId = "p2";
    await loadBusinessDraft(host);
    host.projects.selectedId = "p1";
    host.business.detailLoading = true;
    await loadBusinessDraft(host);
    expect(request).not.toHaveBeenCalled();
  });
});
