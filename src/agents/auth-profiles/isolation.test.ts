import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthProfileStore } from "./types.js";
import { ensureAuthProfileStore } from "./store.js";

const ENV_KEYS = [
  "KOLO_STATE_DIR",
  "KOLO_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "KOLO_CONFIG_PATH",
  "KOLO_DISABLE_CONFIG_CACHE",
] as const;

describe("auth isolation", () => {
  const saved: Record<string, string | undefined> = {};
  let tmp: string;
  let mainDir: string;
  let kidDir: string;

  const mainStore: AuthProfileStore = {
    version: 1,
    profiles: {
      "openai:default": { type: "api_key", provider: "openai", key: "sk-main-openai" },
      "sakura:default": { type: "api_key", provider: "sakura", key: "sk-main-sakura" },
    },
  };

  async function writeConfig(auth: unknown) {
    await fs.writeFile(process.env.KOLO_CONFIG_PATH!, JSON.stringify({ auth }));
  }

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
    }
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "auth-isolation-"));
    mainDir = path.join(tmp, "agents", "main", "agent");
    kidDir = path.join(tmp, "agents", "worker", "agent");
    await fs.mkdir(mainDir, { recursive: true });
    await fs.mkdir(kidDir, { recursive: true });
    process.env.KOLO_STATE_DIR = tmp;
    process.env.KOLO_AGENT_DIR = mainDir;
    process.env.PI_CODING_AGENT_DIR = mainDir;
    process.env.KOLO_CONFIG_PATH = path.join(tmp, "kolo.json");
    process.env.KOLO_DISABLE_CONFIG_CACHE = "1";
    await fs.writeFile(path.join(mainDir, "auth-profiles.json"), JSON.stringify(mainStore));
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("inherit (default): an agent without a store gets the main profiles, and a copy is written", async () => {
    await writeConfig({});
    const store = ensureAuthProfileStore(kidDir);
    expect(Object.keys(store.profiles).toSorted()).toEqual(["openai:default", "sakura:default"]);
    await expect(fs.stat(path.join(kidDir, "auth-profiles.json"))).resolves.toBeTruthy();
  });

  it("explicit: no grant means no credentials, and nothing is copied from main", async () => {
    await writeConfig({ isolation: "explicit" });
    const store = ensureAuthProfileStore(kidDir);
    expect(store.profiles).toEqual({});
    const copied = await fs
      .readFile(path.join(kidDir, "auth-profiles.json"), "utf8")
      .catch(() => "");
    expect(copied).not.toContain("sk-main-openai");
  });

  it("explicit: an agent sees only the granted profile ids", async () => {
    await writeConfig({ isolation: "explicit", grants: { Worker: ["sakura:default"] } });
    const store = ensureAuthProfileStore(kidDir);
    expect(Object.keys(store.profiles)).toEqual(["sakura:default"]);
  });

  it("explicit: profiles in the agent's own file that are not granted stay invisible", async () => {
    const own: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "sk-old-inherited-copy" },
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-own" },
      },
      lastGood: { openai: "openai:default", anthropic: "anthropic:default" },
    };
    await fs.writeFile(path.join(kidDir, "auth-profiles.json"), JSON.stringify(own));
    await writeConfig({ isolation: "explicit", grants: { worker: ["anthropic:default"] } });
    const store = ensureAuthProfileStore(kidDir);
    expect(Object.keys(store.profiles)).toEqual(["anthropic:default"]);
    expect(store.lastGood).toEqual({ anthropic: "anthropic:default" });
  });

  it('explicit: a "*" grant (kurahi init\'s identity agent) sees every profile', async () => {
    await writeConfig({ isolation: "explicit", grants: { worker: ["*"] } });
    const store = ensureAuthProfileStore(kidDir);
    expect(Object.keys(store.profiles).toSorted()).toEqual(["openai:default", "sakura:default"]);
    const { isProfileGranted } = await import("./isolation.js");
    expect(isProfileGranted(["*"], "anything:default")).toBe(true);
    expect(isProfileGranted(["a:x"], "b:y")).toBe(false);
    expect(isProfileGranted(undefined, "a:x")).toBe(false);
  });

  it("explicit: the main agent itself is unaffected", async () => {
    await writeConfig({ isolation: "explicit" });
    const store = ensureAuthProfileStore();
    expect(Object.keys(store.profiles).toSorted()).toEqual(["openai:default", "sakura:default"]);
  });
});

describe("auth isolation: OAuth refresh fallback", () => {
  it("is gated by grants under explicit isolation", async () => {
    const { agentIdForDir, resolveAuthIsolation } = await import("./isolation.js");
    const cfg = { auth: { isolation: "explicit" as const, grants: { worker: ["a:x"] } } };
    const iso = resolveAuthIsolation(cfg);
    expect(iso.mode).toBe("explicit");
    if (iso.mode !== "explicit") {
      return;
    }
    const id = agentIdForDir(
      cfg,
      path.join(os.tmpdir(), "s", "agents", "worker", "agent"),
      Object.keys(iso.grants),
    );
    expect(id).toBe("worker");
    expect(iso.grants[id!]).toEqual(["a:x"]);
  });
});
