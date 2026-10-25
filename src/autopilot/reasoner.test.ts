import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { KoLoConfig } from "../config/config.js";
import type { SpawnResult } from "../process/exec.js";
import { createCliReasoner } from "./reasoner.js";

type Seen = { argv: string[]; cwd?: string; input?: string };

function fakeRun(stdout: string, seen: Seen[], code = 0) {
  return (async (argv: string[], opts: { cwd?: string; input?: string }) => {
    seen.push({ argv, cwd: opts.cwd, input: opts.input });
    expect(fs.existsSync(opts.cwd!)).toBe(true);
    expect(fs.readdirSync(opts.cwd!)).toEqual([]);
    return { stdout, stderr: "", code, signal: null, killed: false } satisfies SpawnResult;
  }) as never;
}

const req = {
  prompt: "PROMPT",
  backend: null,
  model: "gpt-6-luna",
  timeoutMs: 1000,
  runId: "rtest",
  routineId: "r1",
};
const agentMessage = (text: string) =>
  JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text } });

describe("CLI reasoner (tool-less)", () => {
  it("runs codex in the read-only sandbox, ignoring host config and the bypass opt-in", async () => {
    const seen: Seen[] = [];
    const cfg = {
      agents: { defaults: { cliBackends: { "codex-cli": { unsafeSkipPermissions: true } } } },
    } as unknown as KoLoConfig;
    const r = createCliReasoner(cfg, { run: fakeRun(agentMessage('{"items":[]}'), seen) });
    const out = await r.reason(req);
    expect(out).toMatchObject({ text: '{"items":[]}', backend: "codex-cli" });
    const argv = seen[0].argv;
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(argv).toContain("--ignore-user-config");
    expect(argv).not.toContain("danger-full-access");
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv.at(-1)).toBe("PROMPT");
    // The work folder is removed afterwards.
    expect(fs.existsSync(seen[0].cwd!)).toBe(false);
  });

  it("runs claude with no tools at all", async () => {
    const seen: Seen[] = [];
    const r = createCliReasoner({} as KoLoConfig, {
      run: fakeRun(JSON.stringify({ result: '{"items":[]}', session_id: "x" }), seen),
    });
    await r.reason({ ...req, backend: "claude-cli", model: "opus" });
    const argv = seen[0].argv;
    expect(argv).toContain("--restricted");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--session-id");
  });

  it("discards output when the CLI reports a tool call", async () => {
    const out = [
      JSON.stringify({ type: "item.completed", item: { id: "c1", type: "command_execution" } }),
      agentMessage('{"items":[]}'),
    ].join("\n");
    const r = createCliReasoner({} as KoLoConfig, { run: fakeRun(out, []) });
    await expect(r.reason(req)).rejects.toThrow(/tool use/);
  });

  it("refuses backends without a verified tool-less mode and failed runs", async () => {
    const r = createCliReasoner({} as KoLoConfig, { run: fakeRun("", []) });
    await expect(r.reason({ ...req, backend: "my-shell-cli" })).rejects.toThrow(/tool-less/);
    const failing = createCliReasoner({} as KoLoConfig, { run: fakeRun("boom", [], 2) });
    await expect(failing.reason(req)).rejects.toThrow(/exit 2/);
  });
});
