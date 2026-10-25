import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KoLoConfig } from "../config/config.js";
import { createConfigIO, isConfigLoadFailure } from "../config/io.js";
import { getIdentityService, setIdentityServiceForTest } from "./service.js";

const enterprise: KoLoConfig = {
  gateway: {
    identity: {
      publicUrl: "https://gateway.example.test",
      providers: [
        { id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "kurahi" },
      ],
      ssoRequired: true,
    },
  },
};

async function loadFrom(raw: string): Promise<KoLoConfig> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "kolo-identity-config-"));
  try {
    await fs.mkdir(path.join(home, ".kolo"), { recursive: true });
    await fs.writeFile(path.join(home, ".kolo", "kolo.json"), raw);
    const io = createConfigIO({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
      logger: { error: () => undefined, warn: () => undefined },
    });
    return io.loadConfig();
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

afterEach(() => setIdentityServiceForTest(null));

describe("identity settings fail closed on a config that does not load", () => {
  it("marks unreadable and invalid configs, not valid or empty ones", async () => {
    expect(isConfigLoadFailure(await loadFrom("{ not json"))).toBe(true);
    expect(isConfigLoadFailure(await loadFrom(JSON.stringify({ gateway: { port: "x" } })))).toBe(
      true,
    );
    expect(isConfigLoadFailure(await loadFrom(JSON.stringify({ gateway: { port: 19001 } })))).toBe(
      false,
    );
    expect(isConfigLoadFailure({})).toBe(false);
  });

  it("keeps the last good identity settings while the file is broken", async () => {
    setIdentityServiceForTest(null);
    expect(getIdentityService(enterprise).settings.ssoRequired).toBe(true);
    const broken = await loadFrom("{ not json");
    const svc = getIdentityService(broken);
    expect(svc.settings.ssoRequired).toBe(true);
    expect(svc.settings.configured).toBe(true);
    expect(svc.settings.localPersons).toBe(false);
    // The shared service keeps them for later callers without a config too.
    expect(getIdentityService().settings.ssoRequired).toBe(true);
    // A config that loads (here: identity really removed) is applied again.
    expect(getIdentityService({}).settings.ssoRequired).toBe(false);
  });
});
