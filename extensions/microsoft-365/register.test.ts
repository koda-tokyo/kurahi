import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { KoLoPluginApi, KoLoPluginService } from "../../src/plugins/types.js";
import {
  clearConnectorStatusForTest,
  listConnectorStatus,
} from "../../src/connectors/business/index.js";
import { loadPluginManifest } from "../../src/plugins/manifest.js";
import { clearSecretStoreCache } from "../../src/secrets/store.js";
import registerEntra from "../entra/index.js";
import registerGmail from "../gmail/index.js";
import register from "./index.js";

// The plugin wiring as the loader sees it: manifests, registration, the probe service, status.
// The secret store is the real file backend under the isolated test home (test/setup.ts).

beforeAll(() => {
  process.env.KOLO_SECRETS_BACKEND = "file";
  process.env.KOLO_SECRETS_KEY = "test-key-for-business-connectors-0123456789";
  clearSecretStoreCache();
});
afterAll(() => {
  delete process.env.KOLO_SECRETS_BACKEND;
  delete process.env.KOLO_SECRETS_KEY;
  clearSecretStoreCache();
});
afterEach(() => clearConnectorStatusForTest());

function fakeApi(pluginConfig: Record<string, unknown> | undefined) {
  const tools: unknown[] = [];
  const services: KoLoPluginService[] = [];
  const cli: string[] = [];
  const api = {
    id: "test",
    pluginConfig,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    audit: () => {},
    registerTool: (tool: unknown, opts?: { names?: string[] }) => tools.push(opts?.names ?? tool),
    registerService: (s: KoLoPluginService) => services.push(s),
    registerCli: (_r: unknown, opts?: { commands?: string[] }) =>
      cli.push(...(opts?.commands ?? [])),
    lifecycle: { setInterval: () => setTimeout(() => {}, 0) },
  } as unknown as KoLoPluginApi;
  return { api, tools, services, cli };
}

describe("business connector plugins", () => {
  it("ship valid manifests with the catalogue ids", () => {
    for (const dir of ["microsoft-365", "gmail", "entra"]) {
      const res = loadPluginManifest(fileURLToPath(new URL(`../${dir}`, import.meta.url)));
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.manifest.id).toBe(dir);
        expect(res.manifest.configSchema).toBeTruthy();
      }
    }
  });

  it("register nothing but status and CLI when not configured", () => {
    const m = fakeApi(undefined);
    register(m.api);
    const g = fakeApi(undefined);
    registerGmail(g.api);
    const e = fakeApi(undefined);
    registerEntra(e.api);
    expect([...m.tools, ...g.tools, ...e.tools]).toEqual([]);
    expect([...m.cli, ...g.cli, ...e.cli]).toEqual(["m365", "gmail", "entra"]);
    expect(listConnectorStatus()).toEqual([
      expect.objectContaining({ id: "entra", configured: false, error: "not_configured" }),
      expect.objectContaining({ id: "gmail", configured: false, error: "not_configured" }),
      expect.objectContaining({ id: "microsoft-365", configured: false, error: "not_configured" }),
    ]);
  });

  it("configured but not signed in: tools registered, status not authenticated, probe makes no call", async () => {
    const m = fakeApi({
      tenantId: "contoso.onmicrosoft.com",
      clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    register(m.api);
    expect(m.tools).toEqual([
      [
        "m365_mail_list",
        "m365_mail_search",
        "m365_mail_read",
        "m365_mail_attachment_fetch",
        "m365_calendar_list",
        "m365_calendar_read",
      ],
    ]);
    await m.services[0].start({} as never);
    expect(listConnectorStatus()).toEqual([
      {
        id: "microsoft-365",
        configured: true,
        authenticated: false,
        lastProbeOk: null,
        lastProbeAt: null,
        scopes: [],
        error: "not_authenticated",
      },
    ]);
  });
});
