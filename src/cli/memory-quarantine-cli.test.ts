import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdInQuarantine, listQuarantine } from "../memory/quarantine.js";
import { defaultRuntime } from "../runtime.js";
import { registerMemoryQuarantineCli } from "./memory-quarantine-cli.js";

let home: string;
const prevEnv = { ...process.env };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-memq-cli-"));
  process.env.KOLO_HOME = home;
  process.env.KOLO_CONFIG_PATH = path.join(home, "kolo.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...prevEnv };
  fs.rmSync(home, { recursive: true, force: true });
});

function hold(target: string) {
  return holdInQuarantine({
    agentId: "ops",
    reasons: ["turn trust external: hook session"],
    provenance: {
      v: 1,
      id: "rec-1",
      ts: new Date().toISOString(),
      agentId: "ops",
      sessionKey: "hook:webhook:1",
      jobId: null,
      trust: "external",
      trustReasons: ["hook session"],
      tool: "write",
      op: "write",
      path: target,
      contentSha256: "x",
    },
    op: { kind: "write", path: target, content: "held\n" },
  });
}

async function cli(...args: string[]) {
  const program = new Command();
  program.name("test").exitOverride();
  registerMemoryQuarantineCli(program.command("memory"));
  await program.parseAsync(["memory", "quarantine", ...args], { from: "user" });
}

describe("kurahi memory quarantine", () => {
  it("lists pending writes and approves one into active memory", async () => {
    const target = path.join(home, "ws", "MEMORY.md");
    const entry = hold(target);
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});

    await cli("list", "--json");
    const listed = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]).toMatchObject({ agentId: "ops", entry: { id: entry.id } });

    await cli("approve", entry.id, "--yes");
    expect(fs.readFileSync(target, "utf8")).toBe("held\n");
    expect(String(log.mock.calls.at(-1)?.[0])).toMatch(/^Approved /);
    expect(listQuarantine("ops")).toHaveLength(0);
  });

  it("reject leaves memory untouched", async () => {
    const target = path.join(home, "ws", "memory", "x.md");
    const entry = hold(target);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await cli("reject", entry.id, "--agent", "ops");
    expect(fs.existsSync(target)).toBe(false);
    expect(listQuarantine("ops", { status: "rejected" })).toHaveLength(1);
  });
});
