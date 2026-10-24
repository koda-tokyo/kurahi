import { afterEach, describe, expect, it } from "vitest";
import { onAuditEvent, type AuditEvent } from "./audit-log.js";
import { checkExecCommand, enforceExecGuard, ExecGuardBlockedError } from "./exec-guard.js";

let stop: (() => void) | undefined;
afterEach(() => stop?.());

function capture(): AuditEvent[] {
  const events: AuditEvent[] = [];
  stop = onAuditEvent((e) => events.push(e));
  return events;
}

describe("exec guard", () => {
  it("refuses hardline commands and records a denied entry with the pattern", () => {
    const events = capture();
    expect(() =>
      enforceExecGuard("sudo rm -rf / --no-preserve-root", { source: "test", agentId: "a" }),
    ).toThrow(ExecGuardBlockedError);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "exec.guard",
      outcome: "denied",
      identity: "a",
      source: "test",
      detail: { pattern: "rm-rootfs" },
    });
  });

  it("passes ordinary commands and records them unless told not to", () => {
    const events = capture();
    expect(checkExecCommand("git status", { source: "test" })).toBeNull();
    expect(checkExecCommand("ls -la", { source: "test", recordAllowed: false })).toBeNull();
    expect(events.map((e) => e.outcome)).toEqual(["allowed"]);
    expect((events[0].detail as { commandSha256: string }).commandSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("catches obfuscated forms through the normaliser", () => {
    capture();
    for (const cmd of [
      "ｒｍ －ｒｆ ／",
      "r\\m -rf /",
      "r''m -rf ~",
      ":(){ :|:& };:",
      "wsl --shutdown",
    ]) {
      expect(checkExecCommand(cmd, { source: "test" }), cmd).not.toBeNull();
    }
  });

  it("truncates long commands in the audit detail", () => {
    const events = capture();
    checkExecCommand(`echo ${"x".repeat(2000)}`, { source: "test" });
    const detail = events[0].detail as { command: string };
    expect(detail.command.length).toBeLessThan(500);
    expect(detail.command).toMatch(/2005 chars/);
  });
});
