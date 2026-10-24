import path from "node:path";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { auditSafe } from "../audit/audit-log.js";
import { emitEvidenceSignal } from "../evidence/bus.js";
import { normalizeToolName } from "./tool-policy.js";

/**
 * Permission globs on tools (KoLo 2.0, M5 item 2).
 *
 * `agents.list[].permissions` (and `agents.defaults.permissions`) hold rules of
 * the form `class:pattern`, e.g.:
 *
 *   ["write:/workspace/**", "exec:git *", "read:**"]
 *
 * Classes: `read`, `write`, `exec`. Every tool call is classified with a target
 * (path for read/write, command for exec). Rules are matched with globs; when
 * no rule matches, `read` is allowed and `write`/`exec` are denied
 * (deny-by-default). Unclassified tools (messaging, browser, …) are governed by
 * the existing tools.allow/deny policies and are not denied here.
 *
 * The guard is inert until at least one rule is configured — upgrading does not
 * change behaviour for existing installs. When both defaults and an agent entry
 * define rules, the lists are merged (defaults first, entry last; entry rules
 * are evaluated with the same matcher, so the entry effectively extends or
 * overrides via more specific grants).
 *
 * Denied calls throw a tool error the model can see and write an audit entry
 * (`agent.permission_denied`) with agent, tool, class, target and rule.
 */

export type ToolPermissionClass = "read" | "write" | "exec";

export type ParsedPermissionRule = {
  raw: string;
  ruleClass: string;
  pattern: string;
  regex: RegExp;
};

export type ToolPermissionSet = {
  /** True when at least one rule was configured (guard enforced). */
  active: boolean;
  rules: ParsedPermissionRule[];
  /** Human-readable problems for rules that could not be parsed (logged by caller). */
  problems: string[];
  /**
   * Classes denied when no rule matches. Default: write and exec (read stays open). A project
   * scope (src/projects/scope.ts) denies read too, so only the project folder is reachable.
   */
  denyByDefault?: string[];
  /** Normalised path targets matching any of these are denied before the rules are consulted. */
  denyPaths?: RegExp[];
  /** Short label for denial messages ("project Payroll"); defaults to "this agent". */
  label?: string;
  /**
   * When set, only these tools (normalized names) may run at all; anything else is denied
   * before classification. Used by project permission modes (参照 Read / 計画 Plan).
   */
  allowTools?: string[];
};

export type ToolPermissionDecision =
  | { ok: true }
  | { ok: false; reason: string; toolClass: string; target: string; rule: string };

const DENY_BY_DEFAULT_CLASSES = new Set<string>(["write", "exec"]);

function escapeRegExpChar(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/**
 * Compile a glob to an anchored regex.
 * - path mode: `*` matches within a segment, `**` crosses `/`, `?` one char.
 *   A trailing `/**` also matches the base path itself.
 * - command mode: `*`/`**` match anything (including spaces) — prefix semantics.
 */
export function globToRegExp(pattern: string, mode: "path" | "command"): RegExp {
  let out = "^";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      let stars = 0;
      while (pattern[i] === "*") {
        stars += 1;
        i += 1;
      }
      if (mode === "command") {
        out += ".*";
      } else if (stars >= 2) {
        if (pattern[i] === "/") {
          // "**/" matches zero or more intermediate directories.
          out += "(?:.*/)?";
          i += 1;
        } else if (pattern[i] === undefined && out.endsWith("/")) {
          // Trailing "/**" also matches the base path itself.
          out = `${out.slice(0, -1)}(?:/.*)?`;
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += mode === "command" ? "." : "[^/]";
      i += 1;
    } else {
      out += escapeRegExpChar(char);
      i += 1;
    }
  }
  return new RegExp(`${out}$`);
}

function isUniversalPattern(pattern: string): boolean {
  return pattern === "**" || pattern === "*";
}

/**
 * Path globs are matched with `/` as the segment separator (see globToRegExp), so resolved
 * patterns and targets are always put into forward-slash form; on Windows path.resolve
 * produces backslashes, which would otherwise never match the compiled glob.
 */
export function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}

/** Resolve a rule pattern to an absolute glob against the workspace (paths only). */
function resolvePathPattern(pattern: string, workspaceDir: string): string {
  if (isUniversalPattern(pattern)) {
    return pattern;
  }
  // path.resolve (not normalize) for absolute patterns too: on Windows a drive-less "/ws/**"
  // must gain the same drive letter that resolved targets carry, or the two never share a prefix.
  if (path.isAbsolute(pattern)) {
    return toPosixPath(path.resolve(pattern));
  }
  return toPosixPath(path.resolve(workspaceDir, pattern));
}

export function parsePermissionRule(
  raw: string,
  workspaceDir: string,
): { rule?: ParsedPermissionRule; problem?: string } {
  const trimmed = raw.trim();
  const colon = trimmed.indexOf(":");
  if (colon <= 0 || colon === trimmed.length - 1) {
    return {
      problem: `invalid rule "${raw}" (expected "class:pattern", e.g. "write:/workspace/**")`,
    };
  }
  const ruleClass = trimmed.slice(0, colon).trim().toLowerCase();
  const rawPattern = trimmed.slice(colon + 1).trim();
  if (!ruleClass || !rawPattern) {
    return { problem: `invalid rule "${raw}" (empty class or pattern)` };
  }
  if (!/^[a-z0-9_-]+$/.test(ruleClass)) {
    return { problem: `invalid rule "${raw}" (class must be alphanumeric)` };
  }
  const isPathClass = ruleClass === "read" || ruleClass === "write";
  const pattern = isPathClass ? resolvePathPattern(rawPattern, workspaceDir) : rawPattern;
  const regex = isUniversalPattern(pattern)
    ? /^.*$/
    : globToRegExp(pattern, isPathClass ? "path" : "command");
  return { rule: { raw: trimmed, ruleClass, pattern, regex } };
}

/** Merge defaults + agent entry rules (entry last) and compile them. */
export function resolveToolPermissions(input: {
  entry?: string[] | null;
  defaults?: string[] | null;
  workspaceDir: string;
}): ToolPermissionSet {
  const rawRules = [...(input.defaults ?? []), ...(input.entry ?? [])];
  const rules: ParsedPermissionRule[] = [];
  const problems: string[] = [];
  for (const raw of rawRules) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      problems.push(`skipping empty permissions rule (${typeof raw})`);
      continue;
    }
    const parsed = parsePermissionRule(raw, input.workspaceDir);
    if (parsed.problem) {
      problems.push(parsed.problem);
      continue;
    }
    if (parsed.rule) {
      rules.push(parsed.rule);
    }
  }
  return { active: rawRules.length > 0, rules, problems };
}

/** Extract file paths from an apply_patch payload ("*** Update File: path" lines). */
export function extractPatchPaths(patch: unknown): string[] {
  if (typeof patch !== "string" || patch.trim().length === 0) {
    return [];
  }
  const paths: string[] = [];
  const pattern = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(patch)) !== null) {
    const filePath = match[1].trim();
    if (filePath) {
      paths.push(filePath);
    }
  }
  return paths;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Classify a tool call into a permission class with its target(s). */
export function classifyToolCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
): { toolClass: string; targets: string[] } {
  const name = normalizeToolName(toolName);
  const params = args ?? {};
  // The file tools also accept Claude-style `file_path` (normalised to `path` inside the tool,
  // after this guard has run), so classify by the same key the tool will use.
  const filePath = asString(params.path) || asString(params.file_path);
  switch (name) {
    case "read":
      return { toolClass: "read", targets: [filePath] };
    case "write":
    case "edit":
      return { toolClass: "write", targets: [filePath] };
    case "apply_patch": {
      const patchPaths = extractPatchPaths(params.patch);
      return { toolClass: "write", targets: patchPaths.length > 0 ? patchPaths : [""] };
    }
    case "legacy_index":
    case "legacy_query":
    case "legacy_rules":
    case "legacy_dictionary":
    case "legacy_impact":
    case "legacy_design_doc":
    case "legacy_wave_plan":
    case "modernise_plan":
    case "modernise_crud":
    case "modernise_impact":
    case "modernise_inventory":
      // The legacy analyser reads every source file under `path`: guard it as a read of that folder.
      return { toolClass: "read", targets: [asString(params.path) || ""] };
    case "exec":
    case "bash":
      return { toolClass: "exec", targets: [asString(params.command) || ""] };
    case "process":
      return { toolClass: "exec", targets: [`process:${asString(params.action)}`] };
    case "kip_engine_task":
      // Exec class (M5b): plain runs are "kip_engine_task"; asking for a merge
      // requires a rule matching "kip_engine_task:merge" (e.g. exec:kip_engine_task*).
      return {
        toolClass: "exec",
        targets: [params.merge === true ? "kip_engine_task:merge" : "kip_engine_task"],
      };
    case "factory_card_create":
    case "factory_card_move":
    case "factory_card_comment":
      // Exec class (M15): one target per verb, so `exec:factory_card:*` grants all three and
      // `exec:factory_card:comment` only the comment tool. Moving to a column is
      // "factory_card:move" (the state machine, not the rule set, decides legality).
      return { toolClass: "exec", targets: [`factory_card:${name.slice("factory_card_".length)}`] };
    default:
      return { toolClass: name, targets: [""] };
  }
}

/** Normalise a path target: resolve against the workspace, collapse `..`. */
export function normalizePathTarget(target: string, workspaceDir: string): string {
  if (target.length === 0) {
    return "";
  }
  return toPosixPath(path.normalize(path.resolve(workspaceDir, target)));
}

function displayTarget(target: string, workspaceDir: string): string {
  if (!target) {
    return "(unknown target)";
  }
  const rel = path.relative(workspaceDir, target);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return rel;
  }
  return target;
}

/** Evaluate one classified target against the rule set. */
export function checkToolPermission(params: {
  toolName: string;
  args?: Record<string, unknown>;
  permissionSet: ToolPermissionSet;
  workspaceDir: string;
}): ToolPermissionDecision {
  const { permissionSet, workspaceDir } = params;
  if (!permissionSet.active) {
    return { ok: true };
  }
  if (
    permissionSet.allowTools &&
    !permissionSet.allowTools.includes(normalizeToolName(params.toolName))
  ) {
    return {
      ok: false,
      toolClass: normalizeToolName(params.toolName),
      target: "",
      rule: "mode:tool-not-allowed",
      reason: `Permission denied: the tool "${params.toolName}" is not available in the current mode of ${permissionSet.label ?? "this agent"}.`,
    };
  }
  const { toolClass, targets } = classifyToolCall(params.toolName, params.args);
  const isPathClass = toolClass === "read" || toolClass === "write";
  const normalizedTargets = targets.map((target) =>
    isPathClass ? normalizePathTarget(target, workspaceDir) : target,
  );

  // Every target of a call must be allowed (apply_patch can touch many files).
  for (const target of normalizedTargets) {
    if (isPathClass && permissionSet.denyPaths?.some((re) => re.test(target))) {
      return {
        ok: false,
        toolClass,
        target,
        rule: `deny-path:${toolClass}`,
        reason: `Permission denied: "${displayTarget(target, workspaceDir)}" is outside what ${permissionSet.label ?? "this agent"} may reach.`,
      };
    }
    const matched = permissionSet.rules.some(
      (rule) => rule.ruleClass === toolClass && rule.regex.test(target),
    );
    if (matched) {
      continue;
    }
    const defaultDeny = permissionSet.denyByDefault
      ? permissionSet.denyByDefault.includes(toolClass)
      : DENY_BY_DEFAULT_CLASSES.has(toolClass);
    if (!defaultDeny) {
      continue; // read + unclassified tools are allow-by-default
    }
    const shown = isPathClass ? displayTarget(target, workspaceDir) : target || "(empty command)";
    return {
      ok: false,
      toolClass,
      target,
      rule: `default-deny:${toolClass}`,
      reason:
        `Permission denied: ${toolClass} on "${shown}" is not covered by ${permissionSet.label ? `the rules of ${permissionSet.label}` : "this agent's permission rules"} ` +
        `(${toolClass} is deny-by-default). An operator can allow it by adding a rule like ` +
        `"${toolClass}:<pattern>" to agents.list[].permissions.`,
    };
  }
  return { ok: true };
}

export class ToolPermissionDeniedError extends Error {
  constructor(
    message: string,
    public readonly tools: string[],
  ) {
    super(message);
    this.name = "ToolPermissionDeniedError";
  }
}

/**
 * Outermost per-call guard: classify → match → deny with a model-visible tool
 * error + audit entry. Inert when the permission set is inactive.
 */
export function wrapToolWithPermissionGuard(
  tool: AnyAgentTool,
  ctx: {
    permissionSet: ToolPermissionSet;
    workspaceDir: string;
    agentId?: string;
    sessionKey?: string;
  },
): AnyAgentTool {
  const execute = tool.execute;
  if (typeof execute !== "function" || !ctx.permissionSet.active) {
    return tool;
  }
  return {
    ...tool,
    execute: async (...args: Parameters<typeof execute>) => {
      const toolArgs = (args[1] ?? {}) as Record<string, unknown>;
      const decision = checkToolPermission({
        toolName: tool.name,
        args: toolArgs,
        permissionSet: ctx.permissionSet,
        workspaceDir: ctx.workspaceDir,
      });
      if (!decision.ok) {
        const audited = auditSafe({
          identity: ctx.agentId ?? null,
          scope: ctx.sessionKey ?? null,
          action: "agent.permission_denied",
          outcome: "denied",
          source: "agents.tool-permissions",
          detail: {
            agent: ctx.agentId ?? null,
            tool: tool.name,
            class: decision.toolClass,
            target: decision.target,
            rule: decision.rule,
          },
        });
        if (ctx.sessionKey) {
          const sessionKey = ctx.sessionKey;
          void audited.then((entry) =>
            emitEvidenceSignal({
              kind: "permission",
              sessionKey,
              tool: tool.name,
              decision: "deny",
              toolClass: decision.toolClass,
              target: decision.target,
              rule: decision.rule,
              reason: decision.reason,
              auditSeq: entry?.seq,
            }),
          );
        }
        throw new ToolPermissionDeniedError(decision.reason, [tool.name]);
      }
      if (ctx.sessionKey) {
        emitEvidenceSignal({
          kind: "permission",
          sessionKey: ctx.sessionKey,
          tool: tool.name,
          decision: "allow",
        });
      }
      return execute(...args);
    },
  } as AnyAgentTool;
}
