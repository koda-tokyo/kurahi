// Types shared by a console terminal session and its broker.
import type { AuditInput } from "../../audit/audit-log.js";
import type { TerminalEvent } from "../../gateway/protocol/index.js";
import type { Project, ProjectMode } from "../../projects/types.js";
import type { TerminalRisk } from "./codes.js";
import type { DiffStore } from "./diff-store.js";
import type { ApprovalPolicy } from "./gate.js";
import type { ShellBackend } from "./pty-backend.js";
import type { TextRedactor } from "./redact.js";
import type { TerminalSession } from "./session.js";
import type { TerminalSettings } from "./settings.js";
import type { TreeSnapshotter } from "./tree-snapshot.js";

export type ApprovalDecisionValue = "allow-once" | "allow-always" | "deny";
export type ApprovalHandle = {
  approvalId: string;
  expiresAtMs: number;
  decision: Promise<{ decision: ApprovalDecisionValue | null; resolvedBy: string | null }>;
};
export interface ApprovalPort {
  request(req: {
    runId: string;
    sessionId: string;
    projectId: string;
    owner: string;
    command: string;
    cwd: string;
    host: "gateway" | "sandbox";
    risks: TerminalRisk[];
    timeoutMs: number;
  }): ApprovalHandle;
  /** Resolve a pending approval as denied (cancel, close, shutdown). */
  cancel(approvalId: string, by: string): void;
}

export type SessionInit = {
  sessionId: string;
  project: Pick<Project, "id" | "name">;
  name: string;
  owner: string;
  root: string;
  settings: TerminalSettings;
  backend: ShellBackend;
  approvals: ApprovalPort;
  audit: (input: AuditInput) => void;
  deliver: (event: TerminalEvent) => void;
  /** Current project mode (re-read for every line); null when the project is gone or archived. */
  readMode: () => ProjectMode | null;
  /** The project's read-only folders (project-relative), re-read for every line and diff. */
  readOnlyFolders?: () => readonly string[];
  policy: (line: string, cwd: string) => ApprovalPolicy;
  diffs: DiffStore;
  redactor: TextRedactor;
  snapshotter?: TreeSnapshotter;
  onClosed?: (session: TerminalSession) => void;
  now?: () => number;
};
