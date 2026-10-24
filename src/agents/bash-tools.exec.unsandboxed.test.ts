import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// tools.exec.unsandboxed: what exec does with host=sandbox when no sandbox container is active.
vi.mock("./tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));
vi.mock("../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger.js")>()),
  logWarn: vi.fn(),
}));

const isWin = process.platform === "win32";
let prevHome: string | undefined;
let tempDir: string;

beforeEach(async () => {
  prevHome = process.env.HOME;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kurahi-unsandboxed-"));
  process.env.HOME = tempDir;
  const { resetLegacyUnsandboxedWarningForTest } = await import("./bash-tools.exec.js");
  resetLegacyUnsandboxedWarningForTest();
});

afterEach(async () => {
  vi.resetAllMocks();
  if (prevHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = prevHome;
  }
  await (await import("../audit/audit-log.js")).flushAudit();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe.skipIf(isWin)("exec without an active sandbox", () => {
  it("legacy fallback (unset): runs on the host, with a one-time warning", async () => {
    const { logWarn } = await import("../logger.js");
    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "sandbox" });
    const result = await tool.execute("c1", { command: "echo legacy-host" });
    expect(result.content.find((c) => c.type === "text")?.text).toContain("legacy-host");
    await tool.execute("c2", { command: "echo again" });
    const warnings = vi
      .mocked(logWarn)
      .mock.calls.filter(([m]) => String(m).includes("unsandboxed"));
    expect(warnings).toHaveLength(1);
  });

  it('"deny" refuses and explains', async () => {
    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "sandbox", unsandboxed: "deny" });
    await expect(tool.execute("c3", { command: "echo nope" })).rejects.toThrow(
      /no sandbox is active.*unsandboxed is deny/,
    );
  });

  it('"approve" (new installs) sends a non-allowlisted command for human approval', async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    vi.mocked(callGatewayTool).mockImplementation(async () => ({ decision: "deny" }));
    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      host: "sandbox",
      unsandboxed: "approve",
      approvalRunningNoticeMs: 0,
    });
    const result = await tool.execute("c4", { command: "touch /tmp/kurahi-should-wait" });
    expect(result.details.status).toBe("approval-pending");
    expect((result.details as { host?: string }).host).toBe("gateway");
  });

  it("a session that had to be sandboxed but could not be never falls back to the host", async () => {
    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      host: "sandbox",
      unsandboxed: "host",
      sandboxUnavailable: "docker: command not found",
    });
    await expect(tool.execute("c5", { command: "echo hi" })).rejects.toThrow(
      /must run commands in the sandbox, but the sandbox is not available \(docker: command not found\)/,
    );
  });
});
