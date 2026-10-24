import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { KoLoConfig } from "../config/config.js";
import type { SessionSkillSnapshot } from "../config/sessions.js";
import type { CronJob } from "./types.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

// Cron sessions keep the skills snapshot in the session store. A config change (here: disabling a
// skill) never bumps the in-memory snapshot version, so the stored snapshot must carry the config
// it was built under and be rebuilt when that differs.
vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));
vi.mock("../agents/model-catalog.js", () => ({ loadModelCatalog: vi.fn() }));

import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { resolveSkillsConfigKey } from "../agents/skills.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";

const deps = {
  sendMessageWhatsApp: vi.fn(),
  sendMessageTelegram: vi.fn(),
  sendMessageDiscord: vi.fn(),
  sendMessageSignal: vi.fn(),
  sendMessageIMessage: vi.fn(),
} as unknown as CliDeps;

const SESSION_KEY = "agent:ops:cron:job-1";

async function setup(home: string, stale?: SessionSkillSnapshot) {
  const dir = path.join(home, ".kolo", "sessions");
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  const store = stale
    ? { [SESSION_KEY]: { sessionId: "old", updatedAt: 1, skillsSnapshot: stale } }
    : {};
  await fs.writeFile(storePath, JSON.stringify(store), "utf-8");
  const workspace = path.join(home, "ws");
  const skillDir = path.join(workspace, "skills", "probe-skill");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: probe-skill\ndescription: Runs the probe\n---\n\n# probe-skill\n",
    "utf-8",
  );
  const bundled = path.join(home, "bundled-empty");
  await fs.mkdir(bundled, { recursive: true });
  vi.stubEnv("KOLO_BUNDLED_SKILLS_DIR", bundled);
  const cfg = {
    agents: {
      defaults: { model: "anthropic/claude-opus-4-5", workspace },
      list: [{ id: "ops" }],
    },
    session: { store: storePath, mainKey: "main" },
  } as KoLoConfig;
  return { cfg, storePath };
}

function job(): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    agentId: "ops",
    name: "probe",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "Run the probe.", deliver: false },
    state: {},
  };
}

const run = (cfg: KoLoConfig) =>
  runCronIsolatedAgentTurn({
    cfg,
    deps,
    job: job(),
    message: "Run the probe.",
    sessionKey: "cron:job-1",
    agentId: "ops",
    lane: "cron",
  });

const lastSnapshot = () => vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0]?.skillsSnapshot;

describe("cron skills snapshot", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
    vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
    });
  });

  it("rebuilds a stored snapshot from a build that recorded no config key", async () => {
    await withTempHomeBase(async (home) => {
      const { cfg, storePath } = await setup(home, {
        prompt: "STALE",
        skills: [{ name: "removed-skill" }],
        version: 0,
      });
      await run(cfg);
      const snap = lastSnapshot();
      expect(snap?.prompt).not.toBe("STALE");
      expect(snap?.skills.map((s) => s.name)).toContain("probe-skill");
      expect(snap?.skills.map((s) => s.name)).not.toContain("removed-skill");
      expect(snap?.configKey).toBe(resolveSkillsConfigKey(cfg));
      const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(stored[SESSION_KEY].skillsSnapshot.configKey).toBe(resolveSkillsConfigKey(cfg));
    });
  });

  it("keeps a snapshot built under the same config, rebuilds it after a config change", async () => {
    await withTempHomeBase(async (home) => {
      const base = await setup(home);
      const cached: SessionSkillSnapshot = {
        prompt: "CACHED",
        skills: [{ name: "probe-skill" }],
        version: 0,
        configKey: resolveSkillsConfigKey(base.cfg),
      };
      const { cfg } = await setup(home, cached);
      await run(cfg);
      expect(lastSnapshot()?.prompt).toBe("CACHED");

      const edited = {
        ...cfg,
        skills: { entries: { "probe-skill": { enabled: false } } },
      } as KoLoConfig;
      await run(edited);
      const snap = lastSnapshot();
      expect(snap?.prompt).not.toBe("CACHED");
      expect(snap?.skills.map((s) => s.name)).not.toContain("probe-skill");
      expect(snap?.configKey).toBe(resolveSkillsConfigKey(edited));
    });
  });
});

describe("resolveSkillsConfigKey", () => {
  it("ignores key order and undefined fields, sees allowBundled and the filter", () => {
    const a = resolveSkillsConfigKey({ skills: { allowBundled: ["a"], entries: {} } });
    const b = resolveSkillsConfigKey({
      skills: { entries: {}, allowBundled: ["a"], load: undefined },
    });
    expect(a).toBe(b);
    expect(resolveSkillsConfigKey({ skills: { allowBundled: [] } })).not.toBe(
      resolveSkillsConfigKey({ skills: {} }),
    );
    expect(resolveSkillsConfigKey({}, ["x", "y"])).toBe(resolveSkillsConfigKey({}, ["y", "x"]));
    expect(resolveSkillsConfigKey({}, ["x"])).not.toBe(resolveSkillsConfigKey({}));
  });
});
