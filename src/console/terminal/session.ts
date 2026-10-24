// One console terminal session: bound to one project, with a broker-owned prompt. Each submitted
// line goes through the gate (./gate.ts) before anything is spawned; approved lines run as their
// own process group in a PTY (./pty-backend.ts) with cwd inside the project root. Every event
// gets the next seq in the session's ring (./event-log.ts) and is then delivered to the owner.

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { TerminalEvent } from "../../gateway/protocol/index.js";
import type { ProjectMode } from "../../projects/types.js";
import type { TerminalNoticeCode, TerminalRisk, TerminalSafeParams } from "./codes.js";
import type { SessionInit } from "./session-types.js";
import { reportRunDiff } from "./diff-report.js";
import { diffSnapshots } from "./diff-store.js";
import { EventRing, type TerminalEventInput } from "./event-log.js";
import { decideLine, type GateDecision } from "./gate.js";
import { LineEditor } from "./line-editor.js";
import { OutputPipe } from "./output.js";
import { buildShellEnv, type PtyProcess } from "./pty-backend.js";
import { StreamRedactor } from "./redact.js";
import { TreeSnapshotter, type TreeSnapshot } from "./tree-snapshot.js";

export type {
  ApprovalDecisionValue,
  ApprovalHandle,
  ApprovalPort,
  SessionInit,
} from "./session-types.js";

type State = "idle" | "checking" | "approval" | "running" | "closed";
type CloseReason = "client" | "idle" | "shutdown";
type Run = {
  runId: string;
  proc: PtyProcess;
  startedAt: number;
  before: TreeSnapshot | null;
  pipe: OutputPipe;
  stream: StreamRedactor;
  ended: "cancelled" | "closed" | null;
  killTimer: ReturnType<typeof setTimeout> | null;
};

const AUDIT_COMMAND_CHARS = 400;
const KILL_GRACE_MS = 1500;

export class TerminalSession {
  readonly ring: EventRing;
  state: State = "idle";
  cwd: string;
  lastActivity: number;
  commands = 0;
  private previousCwd: string | null = null;
  private cols = 120;
  private rows = 30;
  private editor: LineEditor;
  private echoSeqs: number[] = [];
  private promptText = "";
  private run: Run | null = null;
  private approval: { id: string; cancelled: boolean } | null = null;
  private busyNoticeSent = false;
  /** Keystrokes typed while a line is being checked or a finished command is diffed. */
  private typeahead = "";
  private overLimitNoticeSent = false;
  private readonly snapshotter: TreeSnapshotter;

  constructor(private readonly init: SessionInit) {
    this.ring = new EventRing(init.sessionId, undefined, init.now);
    this.cwd = init.root;
    this.lastActivity = this.now();
    this.editor = new LineEditor(init.settings.maxLineLength);
    this.snapshotter = init.snapshotter ?? new TreeSnapshotter(init.root);
  }

  get id(): string {
    return this.init.sessionId;
  }
  get owner(): string {
    return this.init.owner;
  }
  get projectId(): string {
    return this.init.project.id;
  }
  get sandboxed(): boolean {
    return this.init.backend.sandboxed;
  }

  private now(): number {
    return this.init.now?.() ?? Date.now();
  }

  /** Read through a method: the state changes across awaits, which narrowing does not see. */
  isClosed(): boolean {
    return this.state === "closed";
  }

  relCwd(): string {
    return path.relative(this.init.root, this.cwd).split(path.sep).join("/") || ".";
  }

  emit(input: TerminalEventInput): TerminalEvent {
    const event = this.ring.append(input);
    this.init.deliver(event);
    return event;
  }

  notice(code: TerminalNoticeCode, params?: TerminalSafeParams, runId?: string) {
    this.emit({ type: "notice", code, ...(params ? { params } : {}), ...(runId ? { runId } : {}) });
  }

  private audit(action: string, outcome: string, detail: Record<string, unknown>) {
    this.init.audit({
      identity: this.init.owner,
      scope: `project:${this.init.project.id}`,
      action,
      outcome,
      source: "console.terminal",
      detail: { sessionId: this.id, projectId: this.init.project.id, ...detail },
    });
  }

  private prompt() {
    const rel = this.relCwd();
    this.promptText = `${rel === "." ? "~" : `~/${rel}`} $ `;
    this.echoSeqs = [];
    this.emit({ type: "stdout", data: this.promptText });
  }

  start(mode: ProjectMode) {
    this.notice("ready", { sandboxed: this.sandboxed, mode });
    this.prompt();
  }

  isIdle(now: number): boolean {
    return this.state === "idle" && now - this.lastActivity > this.init.settings.idleTimeoutMs;
  }

  input(data: string): void {
    this.lastActivity = this.now();
    if (this.state === "running" && this.run) {
      this.run.proc.write(data);
      return;
    }
    if (this.state === "approval" && data.includes("\x03")) {
      this.cancel("input");
      return;
    }
    if (this.state === "checking") {
      // Kept for the next prompt (bounded); it goes through the editor and the gate then.
      if (this.typeahead.length + data.length <= this.init.settings.maxLineLength) {
        this.typeahead += data;
      }
      return;
    }
    if (this.state !== "idle") {
      if (!this.busyNoticeSent) {
        this.busyNoticeSent = true;
        this.notice("busy");
      }
      return;
    }
    const r = this.editor.feed(data);
    if (r.echo) {
      this.echoSeqs.push(this.emit({ type: "stdout", data: r.echo }).seq);
    }
    if (r.interrupted) {
      this.prompt();
    }
    if (r.overLimit && !this.overLimitNoticeSent) {
      this.overLimitNoticeSent = true;
      this.notice("line-too-long", { max: this.init.settings.maxLineLength });
    }
    if (r.submitted !== null) {
      this.overLimitNoticeSent = false;
      if (r.discardedRest) {
        this.notice("paste-truncated");
      }
      void this.submit(r.submitted);
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.run?.proc.resize(cols, rows);
  }

  private gate(line: string): GateDecision {
    return decideLine({
      line,
      mode: this.init.readMode(),
      root: this.init.root,
      cwd: this.cwd,
      previousCwd: this.previousCwd,
      readOnlyFolders: this.init.readOnlyFolders?.() ?? [],
      settings: this.init.settings,
      policy: this.init.policy,
      guard: { sessionKey: `terminal:${this.id}`, sandboxed: this.sandboxed },
    });
  }

  private async submit(raw: string): Promise<void> {
    const line = raw.trim();
    const display = this.init.redactor.redact(raw);
    if (display !== raw) {
      for (const seq of this.echoSeqs) {
        this.ring.rewrite(seq, (e) => ({ ...e, data: "" }) as TerminalEvent);
      }
      this.emit({ type: "stdout", data: `\r\x1b[K${this.promptText}${display}\r\n` });
    } else {
      this.emit({ type: "stdout", data: "\r\n" });
    }
    if (!line) {
      this.prompt();
      return;
    }
    this.state = "checking";
    this.busyNoticeSent = false;
    const runId = randomUUID();
    const shown = display.trim();
    const command =
      shown.length > AUDIT_COMMAND_CHARS ? `${shown.slice(0, AUDIT_COMMAND_CHARS)}…` : shown;
    const commandSha256 = createHash("sha256").update(shown, "utf8").digest("hex");
    this.commands += 1;
    const decision = this.gate(line);
    const riskCodes = decision.risks.map((r) => r.code);
    this.audit("terminal.command", decision.action === "refuse" ? "denied" : "ok", {
      runId,
      command,
      commandSha256,
      cwd: this.relCwd(),
      decision: decision.action,
      ...(decision.action === "refuse" ? { code: decision.refusal.code } : {}),
      risks: riskCodes,
    });
    if (decision.action === "refuse") {
      this.notice(decision.refusal.code, decision.refusal.params, runId);
      return this.backToPrompt();
    }
    if (decision.action === "approve") {
      const approved = await this.askApproval(runId, shown, decision.risks);
      if (!approved) {
        return this.isClosed() ? undefined : this.backToPrompt();
      }
      // Re-check after the wait: the mode, the files or a symlink may have changed meanwhile.
      const again = this.gate(line);
      if (again.action === "refuse") {
        this.audit("terminal.command", "denied", {
          runId,
          decision: "recheck",
          code: again.refusal.code,
        });
        this.notice(again.refusal.code, again.refusal.params, runId);
        return this.backToPrompt();
      }
      return this.execute(runId, line, again);
    }
    return this.execute(runId, line, decision);
  }

  private backToPrompt() {
    if (!this.isClosed()) {
      this.state = "idle";
      this.prompt();
      if (this.typeahead) {
        const pending = this.typeahead;
        this.typeahead = "";
        this.input(pending);
      }
    }
  }

  private async askApproval(
    runId: string,
    command: string,
    risks: TerminalRisk[],
  ): Promise<boolean> {
    this.state = "approval";
    const primary = risks[0] ?? { code: "runs-program" as const };
    const handle = this.init.approvals.request({
      runId,
      sessionId: this.id,
      projectId: this.init.project.id,
      owner: this.init.owner,
      command,
      cwd: this.relCwd(),
      host: this.sandboxed ? "sandbox" : "gateway",
      risks,
      timeoutMs: this.init.settings.approvalTimeoutMs,
    });
    this.approval = { id: handle.approvalId, cancelled: false };
    this.emit({
      type: "approval.requested",
      runId,
      approvalId: handle.approvalId,
      command,
      cwd: this.relCwd(),
      risk: primary,
      risks,
      expiresAtMs: handle.expiresAtMs,
    });
    const { decision, resolvedBy } = await handle.decision;
    const cancelled = (this.approval?.cancelled ?? false) || this.isClosed();
    this.approval = null;
    const label = cancelled ? "cancelled" : (decision ?? "timeout");
    this.emit({
      type: "approval.resolved",
      runId,
      approvalId: handle.approvalId,
      decision: label,
      resolvedBy,
    });
    const allowed = !cancelled && (decision === "allow-once" || decision === "allow-always");
    this.audit("terminal.approval", allowed ? "ok" : "denied", {
      runId,
      approvalId: handle.approvalId,
      decision: label,
      resolvedBy,
      risks: risks.map((r) => r.code),
    });
    if (!allowed && !this.isClosed()) {
      this.notice(
        label === "cancelled"
          ? "approval-cancelled"
          : label === "timeout"
            ? "approval-timeout"
            : "approval-denied",
        undefined,
        runId,
      );
    }
    return allowed;
  }

  private async execute(
    runId: string,
    line: string,
    decision: Extract<GateDecision, { action: "run" | "approve" }>,
  ): Promise<void> {
    if (this.state === "closed") {
      return;
    }
    if (decision.cwdAfter !== null) {
      this.previousCwd = this.cwd;
      this.cwd = decision.cwdAfter;
      this.notice("cwd-changed", { cwd: this.relCwd() }, runId);
      return this.backToPrompt();
    }
    this.state = "checking";
    const before = decision.readOnly ? null : await this.snapshotter.snapshot();
    if (this.isClosed()) {
      return;
    }
    const stream = new StreamRedactor(this.init.redactor);
    stream.envValues = decision.printsEnv;
    const pipe = new OutputPipe({
      bytesPerSecond: this.init.settings.outputBytesPerSecond,
      redactor: stream,
      emit: (data) => {
        this.lastActivity = this.now();
        this.emit({ type: "stdout", runId, data });
      },
      onDropped: (bytes) => this.notice("output-rate-limited", { droppedBytes: bytes }, runId),
      now: this.init.now,
    });
    let proc: PtyProcess;
    try {
      proc = this.init.backend.spawn({
        runId,
        line,
        cwd: this.cwd,
        env: buildShellEnv(this.init.root),
        cols: this.cols,
        rows: this.rows,
      });
    } catch (err) {
      this.audit("terminal.exit", "failed", { runId, reason: "spawn-failed", error: String(err) });
      this.notice("spawn-failed", undefined, runId);
      return this.backToPrompt();
    }
    const run: Run = {
      runId,
      proc,
      startedAt: this.now(),
      before,
      pipe,
      stream,
      ended: null,
      killTimer: null,
    };
    this.run = run;
    this.state = "running";
    proc.onData((data) => pipe.write(data));
    proc.onExit((exit) => void this.finish(run, exit.exitCode, exit.signal));
  }

  private async finish(run: Run, exitCode: number | null, signal: string | null): Promise<void> {
    if (run.killTimer) {
      clearTimeout(run.killTimer);
    }
    run.pipe.finish();
    if (this.run === run) {
      this.run = null;
    }
    if (!this.isClosed()) {
      this.state = "checking";
    }
    const durationMs = Math.max(0, this.now() - run.startedAt);
    const reason = run.ended ?? "exited";
    this.emit({ type: "exit", runId: run.runId, exitCode, signal, durationMs, reason });
    let diff: Record<string, unknown> | undefined;
    if (run.before) {
      const after = await this.snapshotter.snapshot();
      diff = reportRunDiff({
        files: diffSnapshots(run.before, after, this.init.redactor),
        truncated: run.before.truncated || after.truncated,
        runId: run.runId,
        sessionId: this.id,
        projectId: this.init.project.id,
        owner: this.init.owner,
        readOnlyFolders: this.init.readOnlyFolders?.() ?? [],
        diffs: this.init.diffs,
        emit: (event) => this.emit(event),
        notice: (code, params) => this.notice(code, params, run.runId),
        audit: (action, outcome, detail) => this.audit(action, outcome, detail),
      });
    }
    this.audit("terminal.exit", exitCode === 0 ? "ok" : "failed", {
      runId: run.runId,
      exitCode,
      signal,
      durationMs,
      reason,
      outputBytes: run.pipe.totalBytes,
      droppedBytes: run.pipe.droppedBytes,
      ...(diff ? { diff } : {}),
    });
    this.backToPrompt();
  }

  private killRun(ended: "cancelled" | "closed", grace: number) {
    const run = this.run;
    if (!run || run.ended) {
      return;
    }
    run.ended = ended;
    run.proc.kill("SIGTERM");
    if (grace <= 0) {
      run.proc.kill("SIGKILL");
      return;
    }
    run.killTimer = setTimeout(() => run.proc.kill("SIGKILL"), grace);
    run.killTimer.unref?.();
  }

  /** Cancel: deny a pending approval, kill the running command's process group, or clear the line. */
  cancel(by: string): void {
    this.lastActivity = this.now();
    const state = this.state;
    this.audit("terminal.cancel", "ok", { state, runId: this.run?.runId, by });
    if (state === "approval" && this.approval) {
      this.approval.cancelled = true;
      this.init.approvals.cancel(this.approval.id, by);
    } else if (state === "running") {
      this.killRun("cancelled", KILL_GRACE_MS);
    } else if (state === "idle") {
      this.editor.reset();
      this.emit({ type: "stdout", data: "^C\r\n" });
      this.prompt();
    }
  }

  close(reason: CloseReason): void {
    if (this.state === "closed") {
      return;
    }
    const wasRunning = this.state === "running";
    this.state = "closed";
    if (this.approval) {
      this.approval.cancelled = true;
      this.init.approvals.cancel(this.approval.id, `terminal.close:${reason}`);
    }
    if (wasRunning) {
      this.killRun("closed", reason === "shutdown" ? 0 : 500);
    }
    this.notice(reason === "idle" ? "idle-timeout" : reason === "shutdown" ? "shutdown" : "closed");
    this.audit("terminal.close", "ok", { reason, commands: this.commands });
    this.init.onClosed?.(this);
  }
}
