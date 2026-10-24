// Projects (Kurahi v0.3): a named folder that agents work in, with the agents allowed to work
// there, the read/write scope the tool guard enforces, rules from a template, and starter
// prompts. Stored under the Kurahi state dir (`<KOLO_HOME>/projects/`).

export type LocalizedText = { ja?: string; en?: string };

export type ProjectRules = {
  /**
   * Folder-relative paths the agent may only read ("." = the whole folder). Everything inside
   * the project folder is readable; this list documents what must never be written.
   */
  readOnly: string[];
  /** Folder-relative paths the agent may write. Empty = nothing in the folder is writable. */
  writable: string[];
  /** Artifacts made in this project must pass 確認中 → 承認済み before they count as final. */
  artifactApprovalRequired: boolean;
  /** Plain-language rules given to the agent with every message in this project. */
  instructions: LocalizedText[];
};

/**
 * Permission mode (Ask / Plan / Act):
 * - read 参照: read tools only; no writes, no commands, nothing outbound.
 * - plan 計画: read, plus writes to the project's plans/ and output/ only; nothing outbound.
 * - act 実行: the project's full file scope (writable folders); approvals still apply.
 * Enforced by the tool guard (src/projects/scope.ts), not by the prompt.
 */
export type ProjectMode = "read" | "plan" | "act";

export type Project = {
  id: string;
  name: string;
  /** Absolute path of the project folder. */
  folder: string;
  /** Agent ids that may work in this project. Empty = the default agent only. */
  allowedAgents: string[];
  /** Model refs (`provider/model`) offered in this project. Empty = the agent's defaults. */
  allowedModels: string[];
  templateId: string | null;
  rules: ProjectRules;
  suggestedSkills: string[];
  /**
   * Plugins enabled for this project only (from its template), e.g. "legacy-analyzer". Their
   * tools run under the project scope; the gateway-wide plugin config is not changed. Missing on
   * projects made before this existed (= none).
   */
  plugins?: string[];
  starterPrompts: LocalizedText[];
  terminalProfile: string;
  /** Missing on projects made before modes existed; those behave as "act" (their old scope). */
  mode?: ProjectMode;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};

export type TerminalProfile = {
  id: string;
  label: LocalizedText;
  allowedCommandsPolicy: LocalizedText;
  enabledByDefault: boolean;
  clientIsolated: boolean;
  justInTime: boolean;
};

export type ProjectTemplate = {
  id: string;
  name: LocalizedText;
  description: LocalizedText;
  /** Sub-folders created inside the project folder when the project is made. */
  folders: string[];
  rules: ProjectRules;
  suggestedAgents: string[];
  suggestedSkills: string[];
  /** Plugins enabled for projects made from this template (project scope only). */
  plugins: string[];
  starterPrompts: LocalizedText[];
  terminalProfile: string;
};
