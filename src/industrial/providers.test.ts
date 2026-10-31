import { describe, expect, it, vi } from "vitest";
import {
  findProvider,
  invokeRemoteProvider,
  listProviders,
  PROVIDER_DESCRIPTORS,
  ProviderError,
  requireProviderAction,
} from "./providers.js";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof ProviderError ? err.code : String(err);
  }
  return "no error";
};

describe("provider capability registry", () => {
  it("lists only offline imports as usable; every remote mode is DISABLED with a reason (AC-044)", () => {
    for (const d of listProviders()) {
      if (d.access_mode === "REMOTE_API" || d.access_mode === "REMOTE_MCP") {
        expect(d.status, d.provider_id).toBe("DISABLED");
        expect(d.reason.length, d.provider_id).toBeGreaterThan(20);
        expect(d.capabilities).toEqual([]);
      } else {
        expect(d.access_mode).toBe("OFFLINE_IMPORT");
        expect(d.status).toBe("IMPORT_ONLY");
      }
    }
    for (const id of [
      "aws-transform-remote",
      "google-mat-remote",
      "ibm-z-remote",
      "ibm-watsonx-ai",
    ]) {
      expect(findProvider(id)?.status).toBe("DISABLED");
    }
  });

  it("states each format's verification with the documentation it follows", () => {
    const formats = PROVIDER_DESCRIPTORS.flatMap((d) =>
      d.formats.map((f) => ({ provider: d.provider_id, ...f })),
    );
    expect(formats.map((f) => `${f.provider}/${f.id}:${f.verification}`).toSorted()).toEqual([
      "aws-transform/analysis-json:UNVERIFIED_SCHEMA",
      "aws-transform/requirements-md:VERIFIED_FROM_DOCS",
      "google-mat/json-report:UNVERIFIED_SCHEMA",
      "google-mat/neo4j-jsonl:VERIFIED_FROM_DOCS",
      "ibm-z/business-rules-export:UNVERIFIED_SCHEMA",
      "ibm-z/understand-docgen-md:VERIFIED_FROM_DOCS",
    ]);
    for (const f of formats) {
      expect(f.docs.length).toBeGreaterThan(0);
      expect(f.docs.every((u) => u.startsWith("https://"))).toBe(true);
      // An unverified schema is never read by a vendor-specific parser.
      if (f.verification === "UNVERIFIED_SCHEMA") {
        expect(f.parser).toBe("generic-mapped");
      }
    }
  });

  it("blocks unknown providers, disabled providers, other modes, missing capabilities and formats", () => {
    expect(code(() => requireProviderAction({ provider: "nope", mode: "OFFLINE_IMPORT" }))).toBe(
      "CAPABILITY_UNAVAILABLE",
    );
    expect(
      code(() => requireProviderAction({ provider: "ibm-z-remote", mode: "REMOTE_MCP" })),
    ).toBe("CAPABILITY_UNAVAILABLE");
    expect(code(() => requireProviderAction({ provider: "ibm-z", mode: "REMOTE_API" }))).toBe(
      "CAPABILITY_UNAVAILABLE",
    );
    expect(
      code(() =>
        requireProviderAction({
          provider: "google-mat",
          mode: "OFFLINE_IMPORT",
          capability: "TRANSFORMATION",
        }),
      ),
    ).toBe("CAPABILITY_UNAVAILABLE");
    expect(
      code(() =>
        requireProviderAction({ provider: "google-mat", mode: "OFFLINE_IMPORT", format: "html" }),
      ),
    ).toBe("CAPABILITY_UNAVAILABLE");
    expect(
      requireProviderAction({
        provider: "google-mat",
        mode: "OFFLINE_IMPORT",
        format: "neo4j-jsonl",
      }).format?.verification,
    ).toBe("VERIFIED_FROM_DOCS");
  });

  it("refuses an unavailable remote action before the transport is called (AC-031)", async () => {
    const transport = vi.fn(async () => ({ ok: true }));
    for (const [provider, mode] of [
      ["aws-transform-remote", "REMOTE_API"],
      ["google-mat-remote", "REMOTE_MCP"],
      ["ibm-z-remote", "REMOTE_MCP"],
      ["ibm-watsonx-ai", "REMOTE_API"],
      ["ibm-z", "REMOTE_MCP"],
    ] as const) {
      await expect(
        invokeRemoteProvider(
          { provider, mode, capability: "TRANSFORMATION" },
          { idempotencyKey: "k1", payload: { source: "PAYCALC" } },
          transport,
        ),
      ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("would pass a verified remote action to the transport with its idempotency key", async () => {
    const registry = [
      {
        ...PROVIDER_DESCRIPTORS[0],
        provider_id: "mock-remote",
        access_mode: "REMOTE_API" as const,
        status: "AVAILABLE" as const,
        capabilities: ["CODE_EXPLANATION" as const],
      },
    ];
    const transport = vi.fn(async () => "done");
    await expect(
      invokeRemoteProvider(
        { provider: "mock-remote", mode: "REMOTE_API", capability: "CODE_EXPLANATION" },
        { idempotencyKey: "", payload: null },
        transport,
        registry,
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(transport).not.toHaveBeenCalled();
    await invokeRemoteProvider(
      { provider: "mock-remote", mode: "REMOTE_API", capability: "CODE_EXPLANATION" },
      { idempotencyKey: "case-1:job-1", payload: null },
      transport,
      registry,
    );
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "case-1:job-1" }),
    );
  });
});
