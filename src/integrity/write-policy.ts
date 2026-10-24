// Write-refusal for registered constitution files (KoLo 2.0, M2b).
//
// A core `before_tool_call` policy: denies agent tool calls that would write a registered path
// (or the registry, its key, or the audit log) and records an audit event. Covers `write`,
// `edit`, `apply_patch` exactly; for `exec` it is a best-effort parse of the command
// (redirect/tee targets, in-place editors, rm/mv/cp/…, and `kurahi integrity init|update`).
// The operator path is `kurahi integrity update <path>` from a terminal, never an agent tool.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditSafe } from "../audit/audit-log.js";
import { resolveAuditDir } from "../audit/audit-log.js";
import { registeredPaths, resolveIntegrityLocations, type IntegrityLocations } from "./registry.js";

export type ProtectedSet = {
  files: Set<string>;
  dirs: string[];
};

const FILE_TOOLS = new Set(["write", "edit", "multiedit", "multi_edit", "notebookedit"]);
const PATCH_TOOLS = new Set(["apply_patch"]);
const SHELL_TOOLS = new Set(["exec", "bash", "shell"]);

const PATCH_MARKERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: ", "*** Move to: "];

/** Commands that modify any path they name. */
const MUTATING_CMD_RE =
  /(^|[\s;&|(])(rm|mv|cp|truncate|dd|chmod|chown|chattr|ln|install|touch|unlink|shred|rsync|sed\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*i|perl\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*i|ed|ex|vi|vim|nvim|nano|emacs|code|python3?|node|ruby|bun|deno|git\s+(checkout|restore|reset|apply|mv|rm|stash))(?=$|[\s;&|)])/;
const OPERATOR_CMD_RE = /\bintegrity\s+(init|update)\b/;
/** Approving a skill or plugin into the supply-chain lock (ASI04) is an operator action too. */
const PIN_CMD_RE = /\b(skills|plugins)\s+pin\b/;
/** Memory quarantine decisions are operator review (src/memory/quarantine.ts, ASI06). */
const MEMORY_REVIEW_CMD_RE = /\bmemory\s+quarantine\s+(approve|reject)\b/;

/** Resolves symlinks through the nearest existing ancestor, so a write under a not-yet-created
 * folder still matches a protected root whose path contains a symlink (e.g. macOS /var). */
function realish(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.toReversed());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) {
        return abs;
      }
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export function buildProtectedSet(params: {
  registered: string[];
  extraFiles?: string[];
  dirs?: string[];
}): ProtectedSet {
  const files = new Set<string>();
  for (const f of [...params.registered, ...(params.extraFiles ?? [])]) {
    files.add(path.resolve(f));
    files.add(realish(f));
  }
  const dirs = [...new Set((params.dirs ?? []).flatMap((d) => [path.resolve(d), realish(d)]))];
  return { files, dirs };
}

export function isProtectedPath(
  candidate: string,
  baseDir: string,
  set: ProtectedSet,
): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }
  const abs = path.resolve(baseDir, expandHome(trimmed));
  for (const p of [abs, realish(abs)]) {
    if (set.files.has(p)) {
      return p;
    }
    for (const dir of set.dirs) {
      if (p === dir || p.startsWith(`${dir}${path.sep}`)) {
        return p;
      }
    }
  }
  return null;
}

function patchPaths(input: string): string[] {
  const out: string[] = [];
  for (const line of input.split(/\r?\n/)) {
    for (const marker of PATCH_MARKERS) {
      if (line.startsWith(marker)) {
        out.push(line.slice(marker.length).trim());
      }
    }
  }
  return out;
}

function shellTokens(command: string): string[] {
  return command
    .split(/[\s'"`;|&()<>]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !t.startsWith("-"));
}

function redirectTargets(command: string): string[] {
  const out: string[] = [];
  // `> file`, `>> file`, `&> file`, `1> file` — but not `2>&1`.
  for (const m of command.matchAll(/(?:^|[^>])>{1,2}\s*(?!&)(["']?)([^\s;&|"'<>]+)\1/g)) {
    out.push(m[2]);
  }
  for (const m of command.matchAll(/\btee\s+((?:-[a-zA-Z]+\s+)*)([^;&|]+)/g)) {
    out.push(...shellTokens(m[2]));
  }
  return out;
}

/** Paths an `apply_patch` input adds, deletes, updates or moves to. */
export function patchTargetPaths(input: string): string[] {
  return patchPaths(input);
}

/** Best-effort paths a shell command writes (redirects, tee, and names given to mutating commands). */
export function execWriteTargets(command: string): string[] {
  const out = redirectTargets(command);
  if (MUTATING_CMD_RE.test(command)) {
    out.push(...shellTokens(command));
  }
  return out;
}

export type WriteDecision = { blocked: false } | { blocked: true; path: string; reason: string };

/** Pure decision for one tool call. */
export function evaluateWritePolicy(params: {
  toolName: string;
  toolParams: Record<string, unknown>;
  baseDir: string;
  set: ProtectedSet;
}): WriteDecision {
  const tool = params.toolName.trim().toLowerCase();
  const p = params.toolParams;
  const deny = (hit: string, why: string): WriteDecision => ({
    blocked: true,
    path: hit,
    reason:
      `${why}: ${hit} is protected by the integrity registry. ` +
      "Constitution files change only by an operator running `kurahi integrity update <path>` in a terminal.",
  });

  if (FILE_TOOLS.has(tool)) {
    for (const key of ["path", "file_path", "filePath", "notebook_path"]) {
      const v = p[key];
      if (typeof v === "string") {
        const hit = isProtectedPath(v, params.baseDir, params.set);
        if (hit) {
          return deny(hit, `${tool} refused`);
        }
      }
    }
    return { blocked: false };
  }
  if (PATCH_TOOLS.has(tool)) {
    const input =
      typeof p.input === "string" ? p.input : typeof p.patch === "string" ? p.patch : "";
    for (const target of patchPaths(input)) {
      const hit = isProtectedPath(target, params.baseDir, params.set);
      if (hit) {
        return deny(hit, "apply_patch refused");
      }
    }
    return { blocked: false };
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = typeof p.command === "string" ? p.command : "";
    if (!command) {
      return { blocked: false };
    }
    if (OPERATOR_CMD_RE.test(command)) {
      return {
        blocked: true,
        path: "kurahi integrity",
        reason:
          "exec refused: `kurahi integrity init|update` is an operator action and cannot run from an agent tool.",
      };
    }
    if (PIN_CMD_RE.test(command)) {
      return {
        blocked: true,
        path: "kurahi pin",
        reason:
          "exec refused: `kurahi skills|plugins pin` approves code into the supply-chain lock; it is an operator action and cannot run from an agent tool.",
      };
    }
    if (MEMORY_REVIEW_CMD_RE.test(command)) {
      return {
        blocked: true,
        path: "kurahi memory quarantine",
        reason:
          "exec refused: `kurahi memory quarantine approve|reject` is operator review and cannot run from an agent tool.",
      };
    }
    const cwd =
      typeof p.workdir === "string" && p.workdir.trim()
        ? path.resolve(params.baseDir, expandHome(p.workdir.trim()))
        : params.baseDir;
    for (const target of redirectTargets(command)) {
      const hit = isProtectedPath(target, cwd, params.set);
      if (hit) {
        return deny(hit, "exec refused (write redirect)");
      }
    }
    if (MUTATING_CMD_RE.test(command)) {
      for (const token of shellTokens(command)) {
        const hit = isProtectedPath(token, cwd, params.set);
        if (hit) {
          return deny(hit, "exec refused (command modifies files)");
        }
      }
    }
  }
  return { blocked: false };
}

type CachedSet = { key: string; set: ProtectedSet };
let cached: CachedSet | null = null;

/** Protected set for the current KOLO_HOME, cached on the registry's mtime. */
export function currentProtectedSet(
  loc: IntegrityLocations = resolveIntegrityLocations(),
): ProtectedSet {
  let mtime = 0;
  try {
    mtime = fs.statSync(loc.registryPath).mtimeMs;
  } catch {
    mtime = -1;
  }
  const key = `${loc.registryPath}:${loc.keyPath}:${mtime}`;
  if (cached?.key === key) {
    return cached.set;
  }
  const set = buildProtectedSet({
    registered: registeredPaths(loc),
    extraFiles: [loc.registryPath, loc.keyPath],
    dirs: [loc.dir, resolveAuditDir()],
  });
  cached = { key, set };
  return set;
}

export type BeforeToolCallPolicy = (
  event: { toolName: string; params: Record<string, unknown> },
  ctx: { agentId?: string; sessionKey?: string; toolName: string },
) => Promise<{ block?: boolean; blockReason?: string } | undefined>;

/** The core policy registered with the global hook runner at gateway boot. */
async function defaultBaseDir(agentId?: string): Promise<string> {
  // Relative tool paths resolve against the agent workspace (the tools' own cwd).
  if (!agentId) {
    return process.cwd();
  }
  try {
    const [{ loadConfig }, { resolveAgentWorkspaceDir }] = await Promise.all([
      import("../config/config.js"),
      import("../agents/agent-scope.js"),
    ]);
    return resolveAgentWorkspaceDir(loadConfig(), agentId);
  } catch {
    return process.cwd();
  }
}

export function createIntegrityWritePolicy(
  opts: {
    resolveBaseDir?: (agentId?: string) => string | Promise<string>;
  } = {},
): BeforeToolCallPolicy {
  return async (event, ctx) => {
    const set = currentProtectedSet();
    if (set.files.size === 0 && set.dirs.length === 0) {
      return undefined;
    }
    const baseDir = await (opts.resolveBaseDir ?? defaultBaseDir)(ctx.agentId);
    const decision = evaluateWritePolicy({
      toolName: event.toolName,
      toolParams: event.params ?? {},
      baseDir,
      set,
    });
    if (!decision.blocked) {
      return undefined;
    }
    void auditSafe({
      identity: ctx.agentId ?? null,
      scope: ctx.sessionKey ?? null,
      action: "integrity.write.denied",
      outcome: "denied",
      source: "before_tool_call",
      detail: { tool: event.toolName, path: decision.path },
    });
    return { block: true, blockReason: decision.reason };
  };
}

export const __testing = {
  resetCache() {
    cached = null;
  },
};
