import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBeforeToolCallHook } from "../agents/pi-tools.before-tool-call.js";
import { flushAudit } from "../audit/audit-log.js";
import { tailAudit } from "../audit/verify.js";
import { initRegistry, resolveIntegrityLocations } from "./registry.js";
import { __testing, buildProtectedSet, evaluateWritePolicy } from "./write-policy.js";

let home: string;
let soul: string;
const prevEnv = { ...process.env };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-wp-"));
  process.env.KOLO_HOME = home;
  soul = path.join(home, "workspace-atlas", "SOUL.md");
  fs.mkdirSync(path.dirname(soul), { recursive: true });
  fs.writeFileSync(soul, "soul\n");
  __testing.resetCache();
});

afterEach(async () => {
  await flushAudit();
  process.env = { ...prevEnv };
  fs.rmSync(home, { recursive: true, force: true });
});

describe("evaluateWritePolicy", () => {
  const ws = () => path.join(home, "workspace-atlas");
  const set = () =>
    buildProtectedSet({
      registered: [soul],
      dirs: [path.join(home, "integrity"), path.join(home, "audit")],
    });
  const decide = (toolName: string, toolParams: Record<string, unknown>) =>
    evaluateWritePolicy({ toolName, toolParams, baseDir: ws(), set: set() }).blocked;

  it("blocks write/edit to a registered path (absolute, relative, file_path)", () => {
    expect(decide("write", { path: soul, content: "x" })).toBe(true);
    expect(decide("write", { path: "SOUL.md", content: "x" })).toBe(true);
    expect(decide("edit", { file_path: "./SOUL.md", old_string: "a", new_string: "b" })).toBe(true);
    expect(decide("write", { path: "NOTES.md", content: "x" })).toBe(false);
    expect(decide("read", { path: soul })).toBe(false);
  });

  it("blocks apply_patch touching a registered path", () => {
    expect(
      decide("apply_patch", {
        input: "*** Begin Patch\n*** Update File: SOUL.md\n@@\n-a\n+b\n*** End Patch",
      }),
    ).toBe(true);
    expect(
      decide("apply_patch", {
        input: "*** Begin Patch\n*** Add File: other.md\n+x\n*** End Patch",
      }),
    ).toBe(false);
  });

  it("blocks exec writes to registered paths and operator commands, allows reads", () => {
    expect(decide("exec", { command: "echo hi > SOUL.md" })).toBe(true);
    expect(decide("exec", { command: `printf x >> ${soul}` })).toBe(true);
    expect(decide("exec", { command: "echo x | tee -a SOUL.md" })).toBe(true);
    expect(decide("exec", { command: "sed -i 's/a/b/' SOUL.md" })).toBe(true);
    expect(decide("exec", { command: `rm -f ${soul}` })).toBe(true);
    expect(decide("exec", { command: `rm -rf ${path.join(home, "integrity")}` })).toBe(true);
    expect(decide("exec", { command: "kurahi integrity update SOUL.md --yes" })).toBe(true);
    // Approving code into the supply-chain lock (ASI04) is an operator action too.
    expect(decide("exec", { command: "kurahi skills pin --all --force" })).toBe(true);
    expect(decide("exec", { command: "npx kurahi plugins pin evil" })).toBe(true);
    expect(decide("exec", { command: "kurahi skills verify" })).toBe(false);
    expect(decide("write", { path: path.join(home, "integrity", "supply-chain.lock.json") })).toBe(
      true,
    );
    // ASI06: an agent may not approve its own quarantined memory write.
    expect(decide("exec", { command: "kurahi memory quarantine approve abc123 --yes" })).toBe(true);
    expect(decide("exec", { command: "kurahi memory quarantine reject abc123" })).toBe(true);
    expect(decide("exec", { command: "kurahi memory quarantine list" })).toBe(false);
    expect(decide("exec", { command: "cat SOUL.md 2>&1 | head -c 400" })).toBe(false);
    expect(decide("exec", { command: "sha256sum SOUL.md" })).toBe(false);
    expect(decide("exec", { command: "echo hi > notes.md" })).toBe(false);
  });
});

describe("core before_tool_call policy (global hook runner)", () => {
  it("denies writes to registered files with an audit event, even with no plugins loaded", async () => {
    initRegistry({ patterns: ["workspace-*/SOUL.md"], loc: resolveIntegrityLocations() });
    const blocked = await runBeforeToolCallHook({
      toolName: "write",
      params: { path: soul, content: "pwned" },
    });
    expect(blocked).toMatchObject({ blocked: true });
    expect((blocked as { reason: string }).reason).toMatch(/kurahi integrity update/);
    const registry = await runBeforeToolCallHook({
      toolName: "write",
      params: { path: path.join(home, "integrity", "registry.json"), content: "{}" },
    });
    expect(registry.blocked).toBe(true);
    const ok = await runBeforeToolCallHook({
      toolName: "write",
      params: { path: path.join(home, "x.md"), content: "x" },
    });
    expect(ok).toMatchObject({ blocked: false });
    await flushAudit();
    const denied = tailAudit(path.join(home, "audit"), 10).filter(
      (e) => e.action === "integrity.write.denied",
    );
    expect(denied).toHaveLength(2);
    expect(denied[0]).toMatchObject({ outcome: "denied", source: "before_tool_call" });
  });
});
