// Workflow Evaluator: the minimal simulated-tool layer (design §7).
//
// - Fixture-backed read tools read from the fixture directory.
// - Consequential tools and write tools go to a side-effect sink: the intended action is recorded,
//   a synthetic success is returned, nothing leaves the host. File writes land in a scratch
//   workspace.
// - Other calls are matched against recorded responses (tools.jsonl); no match returns a typed
//   SIMULATED_UNAVAILABLE result and is reported, not thrown.
// - A fixed clock per scenario keeps deadline checks reproducible.
// Every call is written to the job's evidence through the recorder (tool.call / tool.result), and
// scenario approvals are emitted as approval signals, exactly as the live policy guard does.
import fs from "node:fs";
import path from "node:path";
import type { EvidenceRecorder } from "../evidence/recorder.js";
import { emitEvidenceSignal } from "../evidence/bus.js";
import { digestOf } from "../evidence/redact.js";
import { str } from "./checks.js";

export const SIMULATED_UNAVAILABLE = "SIMULATED_UNAVAILABLE";

export type RecordedCall = { tool: string; args: Record<string, unknown>; result: unknown };

export type ScenarioApproval = {
  tool: string;
  decision: "allow" | "deny";
  approver: string;
};

export type Scenario = {
  /** ISO time the simulated clock starts at. */
  clock: string;
  approvals?: ScenarioApproval[];
  recorded?: RecordedCall[];
};

export type SinkEntry = { tool: string; args: Record<string, unknown>; at: string };

export type SimulatedToolsOptions = {
  recorder: EvidenceRecorder;
  sessionKey: string;
  fixtureDir: string;
  scratchDir: string;
  scenario: Scenario;
  /** Tools whose effects go to the sink (consequential actions and writes). */
  sinkTools: string[];
  /** Simulated milliseconds each tool call takes (advances the clock). */
  stepMs?: number;
};

export class SimulatedTools {
  readonly sink: SinkEntry[] = [];
  readonly unmatched: Array<{ tool: string; args: Record<string, unknown> }> = [];
  private clockMs: number;
  private callSeq = 0;
  private readonly approvalsLeft: ScenarioApproval[];

  constructor(private readonly opts: SimulatedToolsOptions) {
    this.clockMs = Date.parse(opts.scenario.clock);
    if (!Number.isFinite(this.clockMs)) {
      throw new Error(`scenario clock is not a valid time: ${opts.scenario.clock}`);
    }
    this.approvalsLeft = [...(opts.scenario.approvals ?? [])];
    fs.mkdirSync(opts.scratchDir, { recursive: true, mode: 0o700 });
  }

  now(): Date {
    return new Date(this.clockMs);
  }

  advance(ms: number): void {
    this.clockMs += ms;
  }

  /**
   * Ask for a human approval the way the policy guard does: the scenario supplies the decision,
   * and it is recorded as an `approval` evidence event before the action.
   */
  requestApproval(tool: string, args: Record<string, unknown>): "allow" | "deny" {
    const idx = this.approvalsLeft.findIndex((a) => a.tool === tool);
    const found = idx >= 0 ? this.approvalsLeft.splice(idx, 1)[0] : undefined;
    const decision = found?.decision ?? "deny";
    emitEvidenceSignal({
      kind: "approval",
      sessionKey: this.opts.sessionKey,
      tool,
      decision,
      ruleId: "scenario",
      approvalId: `sim-${this.callSeq + 1}`,
      approver: found?.approver ?? null,
      argsDigest: digestOf(args),
    });
    this.advance(this.opts.stepMs ?? 1000);
    return decision;
  }

  /** Run one tool call through the simulator, recording it as evidence. */
  call(tool: string, args: Record<string, unknown>): { ok: boolean; result: unknown } {
    const id = `sim-call-${++this.callSeq}`;
    this.opts.recorder.toolStart({ toolCallId: id, name: tool, args });
    let ok = true;
    let result: unknown;
    try {
      result = this.dispatch(tool, args);
      if (
        result &&
        typeof result === "object" &&
        (result as { error?: string }).error === SIMULATED_UNAVAILABLE
      ) {
        ok = false;
      }
    } catch (err) {
      ok = false;
      result = { error: String(err) };
    }
    this.opts.recorder.toolEnd({
      toolCallId: id,
      name: tool,
      result: typeof result === "string" ? result : JSON.stringify(result),
      isError: !ok,
      error: ok ? undefined : String((result as { error?: string })?.error ?? "error"),
    });
    this.advance(this.opts.stepMs ?? 1000);
    return { ok, result };
  }

  private inside(base: string, rel: string): string {
    const abs = path.resolve(base, rel);
    if (abs !== base && !abs.startsWith(`${base}${path.sep}`)) {
      throw new Error(`path escapes the simulated root: ${rel}`);
    }
    return abs;
  }

  private dispatch(tool: string, args: Record<string, unknown>): unknown {
    if (tool === "read_file") {
      const rel = str(args.path);
      return fs.readFileSync(this.inside(this.opts.fixtureDir, rel), "utf8");
    }
    if (tool === "write_file") {
      const rel = str(args.path);
      const abs = this.inside(this.opts.scratchDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, str(args.content));
      this.sink.push({ tool, args: { path: rel }, at: this.now().toISOString() });
      return { ok: true, path: rel };
    }
    if (this.opts.sinkTools.includes(tool)) {
      this.sink.push({ tool, args, at: this.now().toISOString() });
      return { ok: true, simulated: true };
    }
    const key = JSON.stringify(args);
    const rec = (this.opts.scenario.recorded ?? []).find(
      (r) => r.tool === tool && JSON.stringify(r.args) === key,
    );
    if (rec) {
      return rec.result;
    }
    this.unmatched.push({ tool, args });
    return { error: SIMULATED_UNAVAILABLE, tool };
  }
}
