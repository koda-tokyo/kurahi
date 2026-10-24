// The console terminal broker: owns every terminal session of the gateway. Sessions are bound to
// one project and one operator identity (the actor that opened them); only that identity may
// drive, replay or close them. Limits: sessions per project and per identity, idle timeout,
// line length and output rate (per session). Shutdown kills every running process group.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { AuditInput } from "../../audit/audit-log.js";
import type { KoLoConfig } from "../../config/config.js";
import type { TerminalEvent, TerminalOpenResult } from "../../gateway/protocol/index.js";
import type { Project } from "../../projects/types.js";
import type { ApprovalPolicy } from "./gate.js";
import type { ShellBackend } from "./pty-backend.js";
import { projectMode } from "../../projects/store.js";
import { DiffStore } from "./diff-store.js";
import { collectSecretEnvValues, TextRedactor } from "./redact.js";
import { TerminalSession, type ApprovalPort } from "./session.js";
import { resolveTerminalSettings, type TerminalSettings } from "./settings.js";

export type TerminalErrorCode =
  | "disabled"
  | "project-not-found"
  | "read-mode"
  | "project-folder-missing"
  | "session-limit"
  | "sandbox-unavailable"
  | "backend-unavailable"
  | "not-found"
  | "forbidden"
  | "closed"
  | "cursor-ahead";

export class TerminalError extends Error {
  constructor(
    readonly code: TerminalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TerminalError";
  }
}

export type BackendRequest = { project: Project; root: string; sandbox: boolean };

export type BrokerDeps = {
  getConfig: () => KoLoConfig;
  getProject: (id: string) => Project | null;
  /** Whether the project's terminal profile requires client isolation (sandbox). */
  profileIsolated?: (project: Project) => boolean;
  createBackend: (req: BackendRequest) => Promise<ShellBackend>;
  approvals: ApprovalPort;
  policy: (line: string, cwd: string) => ApprovalPolicy;
  audit: (input: AuditInput) => void;
  /** Deliver one event to the session owner's connections. */
  deliver: (event: TerminalEvent, owner: string) => void;
  secretValues?: string[];
  now?: () => number;
};

const MAX_CLOSED_KEPT = 32;
const SWEEP_MS = 30_000;

export class TerminalBroker {
  private sessions = new Map<string, TerminalSession>();
  private closed = new Map<string, TerminalSession>();
  private readonly diffs = new DiffStore();
  private readonly redactor: TextRedactor;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: BrokerDeps) {
    this.redactor = new TextRedactor(deps.secretValues ?? collectSecretEnvValues());
  }

  settings(): TerminalSettings {
    return resolveTerminalSettings(this.deps.getConfig());
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private audit(
    action: string,
    outcome: string,
    identity: string,
    detail: Record<string, unknown>,
  ) {
    this.deps.audit({ identity, action, outcome, source: "console.terminal", detail });
  }

  private ensureSweeper() {
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.sweepIdle(), SWEEP_MS);
      this.sweeper.unref?.();
    }
  }

  async open(req: { projectId: string; name: string; actor: string }): Promise<TerminalOpenResult> {
    const settings = this.settings();
    const deny = (code: TerminalErrorCode, message: string): never => {
      this.audit("terminal.open", "denied", req.actor, { projectId: req.projectId, code });
      throw new TerminalError(code, message);
    };
    if (!settings.enabled) {
      return deny("disabled", "the console terminal is off (console.terminal.enabled)");
    }
    const project = this.deps.getProject(req.projectId);
    if (!project || project.archived) {
      return deny("project-not-found", "project not found");
    }
    const mode = projectMode(project);
    if (mode === "read") {
      return deny(
        "read-mode",
        "the project is in read mode (参照); terminals need plan or act mode",
      );
    }
    let root: string;
    try {
      root = fs.realpathSync(project.folder);
      if (!fs.statSync(root).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      return deny("project-folder-missing", "the project folder does not exist");
    }
    const open = [...this.sessions.values()];
    if (open.filter((s) => s.projectId === project.id).length >= settings.maxSessionsPerProject) {
      return deny(
        "session-limit",
        `at most ${settings.maxSessionsPerProject} terminals per project`,
      );
    }
    if (open.filter((s) => s.owner === req.actor).length >= settings.maxSessionsPerUser) {
      return deny("session-limit", `at most ${settings.maxSessionsPerUser} terminals per user`);
    }
    const sandbox =
      settings.sandbox === "required" || this.deps.profileIsolated?.(project) === true;
    let backend: ShellBackend;
    try {
      backend = await this.deps.createBackend({ project, root, sandbox });
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err))
        .split("\n")[0]
        .slice(0, 300);
      return deny(
        sandbox ? "sandbox-unavailable" : "backend-unavailable",
        sandbox
          ? `the sandbox could not start: ${reason}`
          : `the terminal could not start: ${reason}`,
      );
    }
    if (sandbox && !backend.sandboxed) {
      backend.dispose?.();
      return deny(
        "sandbox-unavailable",
        "the sandbox is required but the backend is not sandboxed",
      );
    }
    const sessionId = randomUUID();
    const session = new TerminalSession({
      sessionId,
      project,
      name: req.name,
      owner: req.actor,
      root,
      settings,
      backend,
      approvals: this.deps.approvals,
      audit: this.deps.audit,
      deliver: (event) => this.deps.deliver(event, req.actor),
      readMode: () => {
        const p = this.deps.getProject(project.id);
        return p && !p.archived && p.folder === project.folder ? projectMode(p) : null;
      },
      readOnlyFolders: () =>
        this.deps.getProject(project.id)?.rules.readOnly ?? project.rules.readOnly,
      policy: this.deps.policy,
      diffs: this.diffs,
      redactor: this.redactor,
      onClosed: (s) => this.retire(s),
      now: this.deps.now,
    });
    this.sessions.set(sessionId, session);
    this.audit("terminal.open", "ok", req.actor, {
      sessionId,
      projectId: project.id,
      name: req.name,
      mode,
      sandboxed: backend.sandboxed,
    });
    session.start(mode);
    this.ensureSweeper();
    return {
      sessionId,
      projectId: project.id,
      name: req.name,
      mode: mode === "act" ? "act" : "plan",
      sandboxed: backend.sandboxed,
      cwd: ".",
      seq: session.ring.lastSeq,
      limits: {
        maxLineLength: settings.maxLineLength,
        idleTimeoutMs: settings.idleTimeoutMs,
        outputBytesPerSecond: settings.outputBytesPerSecond,
        approvalTimeoutMs: settings.approvalTimeoutMs,
      },
    };
  }

  private retire(session: TerminalSession) {
    this.sessions.delete(session.id);
    this.closed.set(session.id, session);
    while (this.closed.size > MAX_CLOSED_KEPT) {
      const oldest = this.closed.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.closed.delete(oldest);
    }
  }

  /** An open session of `actor`; `allowClosed` also finds recently closed ones (replay). */
  private owned(sessionId: string, actor: string, allowClosed = false): TerminalSession {
    const session =
      this.sessions.get(sessionId) ?? (allowClosed ? this.closed.get(sessionId) : undefined);
    if (!session) {
      throw new TerminalError(
        this.closed.has(sessionId) ? "closed" : "not-found",
        "terminal session not found",
      );
    }
    if (session.owner !== actor) {
      this.audit("terminal.access", "denied", actor, { sessionId });
      throw new TerminalError("forbidden", "this terminal session belongs to another user");
    }
    return session;
  }

  input(sessionId: string, actor: string, data: string): void {
    this.owned(sessionId, actor).input(data);
  }

  resize(sessionId: string, actor: string, cols: number, rows: number): void {
    this.owned(sessionId, actor).resize(cols, rows);
  }

  cancel(sessionId: string, actor: string): void {
    this.owned(sessionId, actor).cancel(actor);
  }

  close(sessionId: string, actor: string): void {
    this.owned(sessionId, actor).close("client");
  }

  replay(sessionId: string, actor: string, afterSeq: number, limit?: number) {
    const ring = this.owned(sessionId, actor, true).ring;
    // seq never resets within a session, so a cursor past the newest event is a client bug
    // (or a cursor from another session): an empty page would read as "caught up".
    if (afterSeq > ring.lastSeq) {
      throw new TerminalError("cursor-ahead", "afterSeq is newer than the session's last event");
    }
    return ring.replay(afterSeq, limit);
  }

  diff(diffId: string, actor: string, cursor?: string) {
    const record = this.diffs.get(diffId);
    if (!record) {
      throw new TerminalError("not-found", "diff not found");
    }
    if (record.owner !== actor) {
      this.audit("terminal.access", "denied", actor, { diffId });
      throw new TerminalError("forbidden", "this diff belongs to another user");
    }
    const page = this.diffs.page(record, cursor);
    return {
      diffId: record.diffId,
      sessionId: record.sessionId,
      runId: record.runId,
      projectId: record.projectId,
      files: page.files,
      totals: record.totals,
      nextCursor: page.nextCursor,
    };
  }

  sweepIdle(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (session.isIdle(now)) {
        session.close("idle");
      }
    }
  }

  get openCount(): number {
    return this.sessions.size;
  }

  /** Gateway shutdown: deny pending approvals and kill every running process group. */
  shutdown(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    for (const session of this.sessions.values()) {
      session.close("shutdown");
    }
  }
}
