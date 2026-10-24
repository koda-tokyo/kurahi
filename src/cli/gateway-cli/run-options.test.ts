import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { addGatewayRunCommand, forwardGatewayOptionsToSubcommand } from "./run.js";

// Builds `gateway`, `gateway run` and `gateway install` the way registerGatewayCli does and
// returns the options the invoked action receives.
function parse(argv: string[]): Record<string, unknown> {
  const program = new Command().exitOverride();
  let captured: Record<string, unknown> | null = null;
  const capture = (cmd: Command) =>
    cmd.action((opts: Record<string, unknown>) => {
      captured = opts;
    });
  const gateway = capture(addGatewayRunCommand(program.command("gateway")));
  capture(addGatewayRunCommand(gateway.command("run")));
  capture(
    gateway
      .command("install")
      .option("--port <port>", "Gateway port")
      .option("--token <token>", "Gateway token")
      .option("--force", "Reinstall", false),
  );
  gateway.hook("preAction", (_gateway, action) => {
    forwardGatewayOptionsToSubcommand(gateway, action);
  });
  program.parse(["node", "kurahi", ...argv]);
  if (!captured) {
    throw new Error("no action ran");
  }
  return captured;
}

describe("gateway subcommand options", () => {
  it("--port after `run` reaches the run command (it used to stay on `gateway`)", () => {
    expect(parse(["gateway", "run", "--port", "18995"]).port).toBe("18995");
  });

  it("--port on `gateway` itself still works", () => {
    expect(parse(["gateway", "--port", "18995"]).port).toBe("18995");
  });

  it("flags after `run` are not reset by the run command's defaults", () => {
    const opts = parse(["gateway", "run", "--force", "--bind", "lan"]);
    expect(opts.force).toBe(true);
    expect(opts.bind).toBe("lan");
  });

  it("`gateway install --port --token --force` reaches install", () => {
    const opts = parse(["gateway", "install", "--port", "18996", "--token", "t", "--force"]);
    expect(opts).toMatchObject({ port: "18996", token: "t", force: true });
  });

  it("no flags: defaults only, no port", () => {
    const opts = parse(["gateway", "run"]);
    expect(opts.port).toBeUndefined();
    expect(opts.force).toBe(false);
  });
});
