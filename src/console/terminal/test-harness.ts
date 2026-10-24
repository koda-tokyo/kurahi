// Test doubles for the console terminal broker: a fake PTY backend that records every spawn,
// a fake approval port, and a temporary project. Real-PTY coverage is in broker.pty.test.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuditInput } from "../../audit/audit-log.js";
import type { KoLoConfig } from "../../config/config.js";
import type { ConsoleTerminalConfig } from "../../config/types.console.js";
import type { TerminalEvent } from "../../gateway/protocol/index.js";
import type { Project, ProjectMode } from "../../projects/types.js";
import type { ApprovalPolicy } from "./gate.js";
import type { PtyExit, PtyProcess, ShellBackend, SpawnRequest } from "./pty-backend.js";
import type { ApprovalDecisionValue, ApprovalPort } from "./session.js";
import { TerminalBroker } from "./broker.js";

export class FakeProc implements PtyProcess {
  static nextPid = 4000;
  readonly pid = FakeProc.nextPid++;
  writes: string[] = [];
  signals: string[] = [];
  resized: Array<[number, number]> = [];
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<(e: PtyExit) => void> = [];
  exited = false;

  constructor(readonly req: SpawnRequest) {}
  write(data: string) {
    this.writes.push(data);
  }
  resize(cols: number, rows: number) {
    this.resized.push([cols, rows]);
  }
  onData(l: (d: string) => void) {
    this.dataListeners.push(l);
  }
  onExit(l: (e: PtyExit) => void) {
    this.exitListeners.push(l);
  }
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    this.exit(null, signal);
  }
  out(data: string) {
    this.dataListeners.forEach((l) => l(data));
  }
  exit(exitCode: number | null, signal: string | null = null) {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.exitListeners.forEach((l) => l({ exitCode, signal }));
  }
}

export class FakeBackend implements ShellBackend {
  spawns: FakeProc[] = [];
  constructor(readonly sandboxed = false) {}
  spawn(req: SpawnRequest): PtyProcess {
    const proc = new FakeProc(req);
    this.spawns.push(proc);
    return proc;
  }
}

export function fakeApprovals() {
  let n = 0;
  const pending = new Map<string, (d: ApprovalDecisionValue | null, by?: string) => void>();
  const requests: Array<Parameters<ApprovalPort["request"]>[0] & { approvalId: string }> = [];
  const cancels: string[] = [];
  const port: ApprovalPort = {
    request(req) {
      const approvalId = `approval-${++n}`;
      requests.push({ ...req, approvalId });
      const decision = new Promise<{
        decision: ApprovalDecisionValue | null;
        resolvedBy: string | null;
      }>((resolve) => {
        pending.set(approvalId, (d, by) => {
          pending.delete(approvalId);
          resolve({ decision: d, resolvedBy: by ?? null });
        });
      });
      return { approvalId, expiresAtMs: 1_000_000, decision };
    },
    cancel(id, by) {
      cancels.push(id);
      pending.get(id)?.("deny", by);
    },
  };
  return {
    port,
    requests,
    cancels,
    resolve(id: string, decision: ApprovalDecisionValue | null, by = "operator") {
      pending.get(id)?.(decision, by);
    },
  };
}

export type Harness = ReturnType<typeof createHarness>;

export function createHarness(
  opts: {
    mode?: ProjectMode;
    terminal?: ConsoleTerminalConfig;
    policy?: ApprovalPolicy;
    secretValues?: string[];
    createBackend?: () => Promise<ShellBackend>;
  } = {},
) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-terminal-")));
  const folder = path.join(base, "project");
  fs.mkdirSync(path.join(folder, "src"), { recursive: true });
  fs.writeFileSync(path.join(folder, "a.txt"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(folder, "src", "main.ts"), "export const x = 1;\n");
  const project: Project = {
    id: "pabcdefghij",
    name: "Demo",
    folder,
    allowedAgents: [],
    allowedModels: [],
    templateId: null,
    rules: { readOnly: [], writable: ["."], artifactApprovalRequired: false, instructions: [] },
    suggestedSkills: [],
    starterPrompts: [],
    terminalProfile: "standard",
    mode: opts.mode ?? "act",
    archived: false,
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    createdBy: "owner",
  };
  const config: KoLoConfig = {
    console: { terminal: { enabled: true, actApprovals: "always", ...opts.terminal } },
  };
  const backend = new FakeBackend();
  const approvals = fakeApprovals();
  const events: TerminalEvent[] = [];
  const audits: AuditInput[] = [];
  let clock = 1_000_000;
  const broker = new TerminalBroker({
    getConfig: () => config,
    getProject: (id) => (id === project.id ? project : null),
    createBackend: opts.createBackend ?? (async () => backend),
    approvals: approvals.port,
    policy: () =>
      opts.policy ?? { security: "full", ask: "off", analysisOk: true, allowlistSatisfied: true },
    audit: (input) => audits.push(input),
    deliver: (event) => events.push(event),
    secretValues: opts.secretValues ?? [],
    now: () => clock,
  });
  return {
    base,
    folder,
    project,
    config,
    backend,
    approvals,
    events,
    audits,
    broker,
    advance(ms: number) {
      clock += ms;
    },
    ofType<T extends TerminalEvent["type"]>(type: T) {
      return events.filter((e): e is Extract<TerminalEvent, { type: T }> => e.type === type);
    },
    notices() {
      return events.filter((e) => e.type === "notice").map((e) => (e as { code: string }).code);
    },
    stdout() {
      return events
        .filter((e) => e.type === "stdout")
        .map((e) => (e as { data: string }).data)
        .join("");
    },
    async open(actor = "owner") {
      return await broker.open({ projectId: project.id, name: "tab", actor });
    },
    cleanup() {
      broker.shutdown();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}
