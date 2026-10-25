import { describe, expect, it, vi } from "vitest";
import { getProvider } from "../../providers/registry.js";
import { probeProvider } from "./probe.js";
import { PROVIDERS_EXIT } from "./shared.js";

const BASE = "https://jp-tok.ml.cloud.ibm.com?project_id=p-1";

describe("probe: IBM IAM providers", () => {
  it("exchanges the API key, then lists chat models with the bearer token", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if ((url as string).startsWith("https://iam.cloud.ibm.com/")) {
        return new Response(JSON.stringify({ access_token: "iam-token", expires_in: 3600 }));
      }
      expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer iam-token");
      // Recorded shape of GET /ml/v1/foundation_model_specs (values fake).
      return new Response(
        JSON.stringify({
          total_count: 2,
          limit: 100,
          first: { href: "x" },
          resources: [
            { model_id: "meta-llama/llama-3-3-70b-instruct", label: "llama", provider: "Meta" },
            { model_id: "ibm/granite-3-8b-instruct", label: "granite", provider: "IBM" },
          ],
        }),
      );
    });
    const result = await probeProvider({
      entry: getProvider("watsonx")!,
      baseUrl: BASE,
      apiKey: "ibm-cloud-key",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toMatchObject({
      ok: true,
      via: "models",
      models: ["ibm/granite-3-8b-instruct", "meta-llama/llama-3-3-70b-instruct"],
    });
    expect(fetchFn.mock.calls[1][0] as string).toBe(
      "https://jp-tok.ml.cloud.ibm.com/ml/v1/foundation_model_specs?version=2024-03-14&filters=function_text_chat",
    );
  });

  it("reports a refused key as an auth failure", async () => {
    const fetchFn = async () => new Response("{}", { status: 400 });
    const result = await probeProvider({
      entry: getProvider("watsonx")!,
      baseUrl: BASE,
      apiKey: "bad",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, exitCode: PROVIDERS_EXIT.auth });
  });
});
