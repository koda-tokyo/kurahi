import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway";
import type { BusinessHost } from "./business";
import { emptyBusiness } from "./business";
import { loadBusinessDocument, unescapeBusinessDocumentText } from "./business-document";
import { DEFAULT_PROJECTS_STATE } from "./projects";

const SHA = "a".repeat(64);

function fixture() {
  const item = {
    id: "i1",
    projectId: "p1",
    revision: 3,
    source: {
      documents: [{ kind: "attachment", ref: "att/quote.pdf", name: "quote.pdf", sha256: SHA }],
      fields: {},
    },
  } as unknown as NonNullable<BusinessHost["business"]["item"]>;
  const document = {
    ref: "att/quote.pdf",
    kind: "attachment",
    name: "quote.pdf",
    mediaType: "application/pdf",
    bytes: 10,
    sha256: SHA,
    recordedSha256: SHA,
    sha256Matches: true as boolean | null,
    version: null,
    binary: true,
    text: "Total &lt;&amp;&gt; &quot;5&quot; &#39;円&#39;" as string | null,
    textSource: "extracted" as "raw" | "extracted" | null,
    extractError: null as string | null,
    truncated: false,
    escaped: "html",
    untrusted: true,
    provenance: {},
  };
  const request = vi.fn().mockResolvedValue({ document });
  const host: BusinessHost = {
    business: { ...emptyBusiness(), projectId: "p1", selectedId: "i1", item },
    connected: true,
    tab: "projects",
    client: { request } as unknown as GatewayBrowserClient,
    projects: { ...DEFAULT_PROJECTS_STATE, selectedId: "p1", view: "business" },
  };
  return { host, request, document };
}

describe("Business source document preview", () => {
  it("reads the listed document and decodes the gateway's HTML escaping once", async () => {
    const { host, request } = fixture();
    await loadBusinessDocument(host, "att/quote.pdf");
    expect(request.mock.calls).toEqual([
      ["workitems.document", { projectId: "p1", id: "i1", ref: "att/quote.pdf", maxChars: 20_000 }],
    ]);
    expect(host.business.documentPreview).toEqual({
      itemId: "i1",
      revision: 3,
      ref: "att/quote.pdf",
      status: "ready",
      text: `Total <&> "5" '円'`,
      textSource: "extracted",
      extractError: null,
      truncated: false,
    });
  });
  it("does not decode twice", () => {
    expect(unescapeBusinessDocumentText("&amp;lt;")).toBe("&lt;");
  });
  it("ignores refs that are not source documents of the item", async () => {
    const { host, request } = fixture();
    await loadBusinessDocument(host, "draft");
    expect(request).not.toHaveBeenCalled();
    expect(host.business.documentPreview).toBeNull();
  });
  it("withholds text when the bytes no longer match the recorded hash", async () => {
    const { host, document } = fixture();
    document.sha256Matches = false;
    await loadBusinessDocument(host, "att/quote.pdf");
    expect(host.business.documentPreview).toMatchObject({
      status: "changed",
      text: null,
      textSource: null,
    });
  });
  it("shows the extractor's reason when there is no text", async () => {
    const { host, document } = fixture();
    document.text = null;
    document.textSource = null;
    document.extractError = "timeout";
    await loadBusinessDocument(host, "att/quote.pdf");
    expect(host.business.documentPreview).toMatchObject({
      status: "ready",
      text: null,
      extractError: "timeout",
    });
  });
  it.each(["ref", "recorded", "untrusted"])("rejects a mismatched %s", async (field) => {
    const { host, document } = fixture();
    if (field === "ref") {
      document.ref = "att/other.pdf";
    }
    if (field === "recorded") {
      document.recordedSha256 = "b".repeat(64);
    }
    if (field === "untrusted") {
      (document as { untrusted: unknown }).untrusted = false;
    }
    await loadBusinessDocument(host, "att/quote.pdf");
    expect(host.business.documentPreview).toMatchObject({ status: "error", text: null });
  });
  it("drops a response that arrives after the item changed", async () => {
    const { host, request, document } = fixture();
    let resolve!: (value: unknown) => void;
    request.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const pending = loadBusinessDocument(host, "att/quote.pdf");
    host.business = { ...host.business, item: { ...host.business.item!, revision: 4 } };
    resolve({ document });
    await pending;
    expect(host.business.documentPreview?.status).toBe("loading");
  });
  it("does not expose transport errors", async () => {
    const { host, request } = fixture();
    request.mockRejectedValueOnce(new Error("private backend path"));
    await loadBusinessDocument(host, "att/quote.pdf");
    expect(host.business.documentPreview).toMatchObject({ status: "error", text: null });
    expect(JSON.stringify(host.business)).not.toContain("private backend path");
  });
});
