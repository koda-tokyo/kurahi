import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const callGatewayFromCli = vi.fn(async (method: string, _opts: unknown, params?: unknown) => {
  if (method === "cron.status") {
    return { enabled: true };
  }
  return { ok: true, params };
});

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
      callGatewayFromCli(method, opts, params, extra),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number) => {
      throw new Error(`__exit__:${code}`);
    },
  },
}));

async function cli(args: string[]) {
  callGatewayFromCli.mockClear();
  const { registerCronCli } = await import("./cron-cli.js");
  const program = new Command();
  program.exitOverride();
  registerCronCli(program);
  await program.parseAsync(args, { from: "user" });
}

type Sent = { payload?: Record<string, unknown>; patch?: { payload?: Record<string, unknown> } };
const sent = (method: string) =>
  callGatewayFromCli.mock.calls.find((call) => call[0] === method)?.[2] as Sent | undefined;

const add = ["cron", "add", "--name", "Ops", "--cron", "* * * * *", "--session", "isolated"];

describe("cron --prompt-mode", () => {
  it("sends payload.promptMode on cron add", { timeout: 60_000 }, async () => {
    await cli([...add, "--message", "hi", "--prompt-mode", " Minimal "]);
    expect(sent("cron.add")?.payload?.promptMode).toBe("minimal");
  });

  it("omits it when not given", async () => {
    await cli([...add, "--message", "hi"]);
    expect(sent("cron.add")?.payload).not.toHaveProperty("promptMode");
  });

  it("rejects an unknown mode", async () => {
    await expect(cli([...add, "--message", "hi", "--prompt-mode", "lean"])).rejects.toThrow(
      "__exit__:1",
    );
    expect(callGatewayFromCli.mock.calls.some((call) => call[0] === "cron.add")).toBe(false);
  });

  it("sets and clears it on cron edit", async () => {
    await cli(["cron", "edit", "job-1", "--prompt-mode", "full"]);
    expect(sent("cron.update")?.patch?.payload).toEqual({ kind: "agentTurn", promptMode: "full" });
    await cli(["cron", "edit", "job-1", "--clear-prompt-mode"]);
    expect(sent("cron.update")?.patch?.payload).toEqual({ kind: "agentTurn", promptMode: null });
  });
});
