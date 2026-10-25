import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { KoLoPluginApi, KoLoPluginService } from "../../src/plugins/types.js";
import {
  clearConnectorStatusForTest,
  listConnectorStatus,
} from "../../src/connectors/business/index.js";
import { loadPluginManifest } from "../../src/plugins/manifest.js";
import { clearSecretStoreCache, resolveSecretStore } from "../../src/secrets/store.js";
import registerBox from "../box/index.js";
import registerFreee from "../freee/index.js";
import registerLineWorks from "../line-works/index.js";
import registerMoneyForward from "../money-forward/index.js";
import registerSmartHR from "../smarthr/index.js";
import registerKintone from "./index.js";

// The Japanese SaaS connector plugins as the loader sees them: manifests, registration, the probe
// service, status and the API-token login. The secret store is the real file backend under the
// isolated test home (test/setup.ts). No request leaves the process.

const PLUGINS = [
  ["kintone", registerKintone, "kintone"],
  ["freee", registerFreee, "freee"],
  ["money-forward", registerMoneyForward, "moneyforward"],
  ["smarthr", registerSmartHR, "smarthr"],
  ["line-works", registerLineWorks, "lineworks"],
  ["box", registerBox, "box"],
] as const;

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
  const audits: Array<{ action: string; outcome?: string; detail?: Record<string, unknown> }> = [];
  const program = new Command();
  program.exitOverride();
  const api = {
    id: "test",
    pluginConfig,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    audit: (a: (typeof audits)[number]) => audits.push(a),
    registerTool: (tool: unknown, opts?: { names?: string[] }) => tools.push(opts?.names ?? tool),
    registerService: (s: KoLoPluginService) => services.push(s),
    registerCli: (r: (ctx: { program: Command }) => void, opts?: { commands?: string[] }) => {
      cli.push(...(opts?.commands ?? []));
      r({ program });
    },
    lifecycle: { setInterval: () => setTimeout(() => {}, 0) },
  } as unknown as KoLoPluginApi;
  return { api, tools, services, cli, audits, program };
}

describe("Japanese SaaS connector plugins", () => {
  it("ship valid manifests with the catalogue ids", () => {
    for (const [dir] of PLUGINS) {
      const res = loadPluginManifest(fileURLToPath(new URL(`../${dir}`, import.meta.url)));
      expect(res.ok, dir).toBe(true);
      if (res.ok) {
        expect(res.manifest.id).toBe(dir);
        expect(res.manifest.configSchema).toBeTruthy();
      }
    }
  });

  it("register nothing but status and CLI when not configured", () => {
    const all = PLUGINS.map(([, register]) => {
      const f = fakeApi(undefined);
      register(f.api);
      return f;
    });
    expect(all.flatMap((f) => f.tools)).toEqual([]);
    expect(all.flatMap((f) => f.cli)).toEqual(PLUGINS.map(([, , cli]) => cli));
    expect(listConnectorStatus().map((e) => [e.id, e.configured, e.error])).toEqual(
      PLUGINS.map(([id]) => [id, false, "not_configured"]).toSorted((a, b) =>
        String(a[0]).localeCompare(String(b[0])),
      ),
    );
  });

  it("API-token connectors: configured without OAuth, not signed in until login stores a token", async () => {
    const config = { subdomain: "example", apps: [{ id: 12, fields: ["顧客名"] }] };
    const k = fakeApi(config);
    registerKintone(k.api);
    expect(k.tools).toEqual([["kintone_apps_list", "kintone_records_query", "kintone_record_get"]]);
    await k.services[0].start({} as never);
    expect(listConnectorStatus()).toEqual([
      expect.objectContaining({
        id: "kintone",
        configured: true,
        authenticated: false,
        error: "not_authenticated",
      }),
    ]);
    const s = fakeApi({ tenant: "example" });
    registerSmartHR(s.api);
    expect(s.tools).toEqual([
      ["smarthr_crews_list", "smarthr_crew_get", "smarthr_departments_list"],
    ]);
  });

  it("kintone login --stdin stores one token per app and audits the scopes, never the token", async () => {
    const k = fakeApi({ subdomain: "example", apps: [{ id: 12, fields: ["顧客名"] }] });
    registerKintone(k.api);
    const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd";
    const stdin = process.stdin;
    const fake = (async function* () {
      yield Buffer.from(`${token}\n`);
    })();
    Object.defineProperty(process, "stdin", { value: fake, configurable: true });
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await k.program.parseAsync(["node", "kurahi", "kintone", "login", "--stdin"]);
    } finally {
      process.stdout.write = write;
      Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
    }
    const stored = resolveSecretStore().get("connector.kintone.token");
    expect(JSON.parse(JSON.parse(stored!).accessToken)).toEqual({ "12": token });
    expect(out.join("")).toContain("Granted: kintone.records.read");
    expect(k.audits.at(-1)).toMatchObject({
      action: "connector.kintone.login",
      outcome: "ok",
      detail: { flow: "credential", scopes: ["kintone.records.read"] },
    });
    expect(JSON.stringify(k.audits)).not.toContain(token);
    expect(out.join("")).not.toContain(token);
    resolveSecretStore().delete("connector.kintone.token");
  });
});
