// Memory write guard (OWASP ASI06): the tool wrapper that tags, flags or quarantines memory
// writes made through agent tools, and notices when a turn has read untrusted external content.
//
// One `MemoryTurn` is created per run (createKoLoCodingTools) and shared by every tool of that
// run. It starts from the trust of the input that triggered the turn (operator, channel user,
// cron job, hook/external) and is lowered to `external` as soon as a tool returns external
// content (web, browser, MCP, a file outside the workspace, a network fetch from exec, or any
// result carrying the untrusted-content markers). A memory write after that point is
// "external-origin".
//
// mode off: inert. warn: record provenance, flag (log + audit) what enforce would hold, the write
// lands. enforce: flagged writes are held in quarantine (src/memory/quarantine.ts) and the agent
// is told so; flagged exec writes are refused (a shell command cannot be replayed safely).

import path from "node:path";
import type { AnyAgentTool } from "../agents/pi-tools.types.js";
import type { KoLoConfig } from "../config/config.js";
import { jsonResult } from "../agents/tools/common.js";
import { auditSafe } from "../audit/audit-log.js";
import { execWriteTargets, patchTargetPaths } from "../integrity/write-policy.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getMcpToolMeta } from "../mcp/client/meta.js";
import { detectSuspiciousPatterns } from "../security/external-content.js";
import { isMemoryPath, normalizeExtraMemoryPaths } from "./internal.js";
import {
  appendProvenanceRecord,
  classifySessionTrust,
  memoryPathKey,
  newProvenanceId,
  resolveMemoryProvenanceMode,
  resolveProvenanceDir,
  resolveProvenanceRoot,
  resolveQuarantineTrust,
  sha256File,
  sha256Text,
  type MemoryProvenanceMode,
  type MemoryTrustLevel,
  type MemoryWriteOp,
  type SessionTrust,
} from "./provenance.js";
import { holdInQuarantine, type QuarantinedOp } from "./quarantine.js";

const log = createSubsystemLogger("memory/provenance");

const FILE_WRITE_TOOLS = new Set(["write", "edit"]);
const EXTERNAL_TOOLS = new Set(["web_fetch", "web_search", "browser"]);
const NETWORK_CMD_RE = /(^|[\s;&|(])(curl|wget|http|https|lynx|w3m|aria2c|yt-dlp)(?=$|[\s;&|)])/;
const UNTRUSTED_MARKER = "<<<EXTERNAL_UNTRUSTED_CONTENT>>>";
const RESULT_SCAN_CHARS = 200_000;

export type MemoryTurn = {
  agentId: string;
  sessionKey: string | null;
  jobId: string | null;
  current(): { trust: MemoryTrustLevel; reasons: string[] };
  taint(reason: string): void;
};

export function createMemoryTurn(params: {
  agentId: string;
  sessionKey?: string | null;
  senderId?: string | null;
  messageProvider?: string | null;
  prompt?: string | null;
}): MemoryTurn {
  const base: SessionTrust = classifySessionTrust(params);
  const taints: string[] = [];
  return {
    agentId: params.agentId,
    sessionKey: params.sessionKey ?? null,
    jobId: base.jobId,
    current: () =>
      taints.length > 0
        ? { trust: "external", reasons: [...base.reasons, ...taints] }
        : { trust: base.trust, reasons: [...base.reasons] },
    taint: (reason) => {
      if (!taints.includes(reason)) {
        taints.push(reason);
      }
    },
  };
}

export type MemoryGuardContext = {
  turn: MemoryTurn;
  mode: MemoryProvenanceMode;
  quarantineTrust: MemoryTrustLevel[];
  /** Directory relative tool paths resolve against (the tools' cwd / sandbox root). */
  root: string;
  /** The agent workspace (MEMORY.md, memory/**). */
  workspaceDir: string;
  extraPaths?: string[];
  env?: NodeJS.ProcessEnv;
};

export function resolveMemoryGuardContext(params: {
  config?: KoLoConfig;
  turn: MemoryTurn;
  root: string;
  workspaceDir: string;
  extraPaths?: string[];
}): MemoryGuardContext | null {
  const mode = resolveMemoryProvenanceMode(params.config, params.turn.agentId);
  if (mode === "off") {
    return null;
  }
  return {
    turn: params.turn,
    mode,
    quarantineTrust: resolveQuarantineTrust(params.config, params.turn.agentId),
    root: params.root,
    workspaceDir: params.workspaceDir,
    extraPaths: params.extraPaths,
  };
}

type MemoryTarget = { absPath: string };
type PlannedWrite = {
  op: MemoryWriteOp;
  targets: MemoryTarget[];
  text: string;
  quarantinable: QuarantinedOp | null;
};

function str(p: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof p[key] === "string") {
      return p[key];
    }
  }
  return undefined;
}

function expandHome(p: string): string {
  const home = process.env.HOME ?? "";
  return home && (p === "~" || p.startsWith("~/")) ? path.join(home, p.slice(1)) : p;
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function isMemoryTarget(absPath: string, ctx: MemoryGuardContext): boolean {
  for (const base of new Set([ctx.workspaceDir, ctx.root])) {
    if (within(absPath, base)) {
      const rel = path.relative(base, absPath).replace(/\\/g, "/");
      if (rel && isMemoryPath(rel)) {
        return true;
      }
    }
  }
  for (const extra of normalizeExtraMemoryPaths(ctx.workspaceDir, ctx.extraPaths)) {
    if ((absPath === extra || within(absPath, extra)) && absPath.endsWith(".md")) {
      return true;
    }
  }
  return false;
}

function resolveAbs(candidate: string, base: string): string {
  return path.resolve(base, expandHome(candidate.trim()));
}

/** Refuses agent writes to the provenance sidecar and quarantine (they are operator state). */
function touchesProvenanceStore(paths: string[], ctx: MemoryGuardContext): string | null {
  const root = memoryPathKey(resolveProvenanceRoot(ctx.env));
  for (const p of paths) {
    if (within(memoryPathKey(p), root)) {
      return p;
    }
  }
  return null;
}

/** Which memory files a tool call writes, and what it writes. Null when it writes none. */
export function planMemoryWrite(
  toolName: string,
  params: Record<string, unknown>,
  ctx: MemoryGuardContext,
): (PlannedWrite & { allPaths: string[] }) | null {
  const tool = toolName.trim().toLowerCase();
  if (FILE_WRITE_TOOLS.has(tool)) {
    const raw = str(params, "path", "file_path", "filePath");
    if (!raw?.trim()) {
      return null;
    }
    const absPath = resolveAbs(raw, ctx.root);
    const memory = isMemoryTarget(absPath, ctx);
    if (tool === "write") {
      const content = str(params, "content") ?? "";
      return {
        op: "write",
        allPaths: [absPath],
        targets: memory ? [{ absPath }] : [],
        text: content,
        quarantinable: { kind: "write", path: absPath, content },
      };
    }
    const oldText = str(params, "oldText", "old_string") ?? "";
    const newText = str(params, "newText", "new_string") ?? "";
    return {
      op: "edit",
      allPaths: [absPath],
      targets: memory ? [{ absPath }] : [],
      text: newText,
      quarantinable: { kind: "edit", path: absPath, oldText, newText },
    };
  }
  if (tool === "apply_patch") {
    const input = str(params, "input", "patch") ?? "";
    const allPaths = patchTargetPaths(input).map((p) => resolveAbs(p, ctx.root));
    return {
      op: "patch",
      allPaths,
      targets: allPaths.filter((p) => isMemoryTarget(p, ctx)).map((absPath) => ({ absPath })),
      text: input,
      quarantinable: { kind: "patch", cwd: ctx.root, input, paths: allPaths },
    };
  }
  if (tool === "exec" || tool === "bash") {
    const command = str(params, "command") ?? "";
    if (!command) {
      return null;
    }
    const workdir = str(params, "workdir");
    const cwd = workdir?.trim() ? resolveAbs(workdir, ctx.root) : ctx.root;
    const allPaths = execWriteTargets(command).map((p) => resolveAbs(p, cwd));
    return {
      op: "exec",
      allPaths,
      targets: allPaths.filter((p) => isMemoryTarget(p, ctx)).map((absPath) => ({ absPath })),
      text: command,
      quarantinable: null,
    };
  }
  return null;
}

function resultText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  let out = "";
  for (const part of content) {
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      out += (part as { text: string }).text;
      if (out.length > RESULT_SCAN_CHARS) {
        break;
      }
    }
  }
  return out;
}

/** Why a finished tool call counts as external input for the rest of the turn, if it does. */
export function externalInputReason(
  tool: AnyAgentTool,
  params: Record<string, unknown>,
  result: unknown,
  ctx: MemoryGuardContext,
): string | null {
  const name = (tool.name ?? "").trim().toLowerCase();
  if (EXTERNAL_TOOLS.has(name)) {
    return `read external content (${name})`;
  }
  if (getMcpToolMeta(tool) || name.startsWith("mcp_")) {
    return `read external content (MCP ${name})`;
  }
  if (name === "read") {
    const raw = str(params, "path", "file_path", "filePath");
    if (raw) {
      const abs = resolveAbs(raw, ctx.root);
      if (!within(abs, ctx.workspaceDir) && !within(abs, ctx.root)) {
        return "read a file outside the workspace";
      }
    }
  }
  if (name === "exec" || name === "bash") {
    const command = str(params, "command") ?? "";
    if (NETWORK_CMD_RE.test(command)) {
      return "exec fetched from the network";
    }
  }
  if (resultText(result).includes(UNTRUSTED_MARKER)) {
    return `tool result carries external untrusted content (${name})`;
  }
  return null;
}

function provenanceBase(
  ctx: MemoryGuardContext,
  tool: string,
  plan: PlannedWrite,
  suspicious: string[],
) {
  const { trust, reasons } = ctx.turn.current();
  return {
    v: 1 as const,
    id: newProvenanceId(),
    ts: new Date().toISOString(),
    agentId: ctx.turn.agentId,
    sessionKey: ctx.turn.sessionKey,
    jobId: ctx.turn.jobId,
    trust,
    trustReasons: reasons,
    tool,
    op: plan.op,
    contentSha256: sha256Text(plan.text),
    ...(suspicious.length > 0 ? { suspicious } : {}),
  };
}

function record(
  ctx: MemoryGuardContext,
  base: ReturnType<typeof provenanceBase>,
  plan: PlannedWrite,
) {
  const dir = resolveProvenanceDir(ctx.turn.agentId, ctx.env);
  for (const target of plan.targets) {
    appendProvenanceRecord(dir, {
      ...base,
      id: newProvenanceId(),
      path: memoryPathKey(target.absPath),
      fileSha256After: sha256File(target.absPath),
      status: "active",
    });
  }
}

export function wrapToolWithMemoryProvenance(
  tool: AnyAgentTool,
  ctx: MemoryGuardContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (typeof execute !== "function") {
    return tool;
  }
  const name = tool.name || "tool";
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const args = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
      const plan = planMemoryWrite(name, args, ctx);
      const store = plan ? touchesProvenanceStore(plan.allPaths, ctx) : null;
      if (store) {
        void auditSafe({
          identity: ctx.turn.agentId,
          scope: ctx.turn.sessionKey,
          action: "memory.provenance.write.denied",
          outcome: "denied",
          source: "memory.provenance",
          detail: { tool: name, path: store },
        });
        throw new Error(
          `${name} refused: ${store} is the memory provenance store; only the operator changes it (\`kurahi memory quarantine\`).`,
        );
      }
      if (!plan || plan.targets.length === 0) {
        const result = await execute(toolCallId, params, signal, onUpdate);
        const reason = externalInputReason(tool, args, result, ctx);
        if (reason) {
          ctx.turn.taint(reason);
        }
        return result;
      }
      const suspicious = detectSuspiciousPatterns(plan.text);
      const base = provenanceBase(ctx, name, plan, suspicious);
      const flagReasons = [
        ...(ctx.quarantineTrust.includes(base.trust)
          ? [`turn trust ${base.trust}: ${base.trustReasons.join("; ")}`]
          : []),
        ...(suspicious.length > 0 ? [`suspicious patterns: ${suspicious.join(", ")}`] : []),
      ];
      const paths = plan.targets.map((t) => t.absPath);
      if (flagReasons.length > 0 && ctx.mode === "enforce") {
        if (!plan.quarantinable) {
          appendProvenanceRecord(resolveProvenanceDir(ctx.turn.agentId, ctx.env), {
            ...base,
            path: memoryPathKey(paths[0]),
            fileSha256After: null,
            status: "refused",
          });
          void auditSafe({
            identity: ctx.turn.agentId,
            scope: ctx.turn.sessionKey,
            action: "memory.write.refused",
            outcome: "denied",
            source: "memory.provenance",
            detail: { tool: name, paths, trust: base.trust, reasons: flagReasons },
          });
          throw new Error(
            `${name} refused: this command writes memory (${paths.join(", ")}) after untrusted input. ` +
              "Use the write or edit tool so the change can be held for operator review.",
          );
        }
        const entry = holdInQuarantine({
          agentId: ctx.turn.agentId,
          reasons: flagReasons,
          provenance: { ...base, path: memoryPathKey(paths[0]) },
          op: plan.quarantinable,
          env: ctx.env,
        });
        void auditSafe({
          identity: ctx.turn.agentId,
          scope: ctx.turn.sessionKey,
          action: "memory.quarantine.hold",
          outcome: "held",
          source: "memory.provenance",
          detail: { id: entry.id, tool: name, paths, trust: base.trust, reasons: flagReasons },
        });
        log.warn(`memory write held in quarantine ${entry.id} (${name} ${paths.join(", ")})`);
        return jsonResult({
          status: "quarantined",
          quarantineId: entry.id,
          paths,
          reasons: flagReasons,
          message:
            "This memory write was NOT applied. It is held for operator review because the turn " +
            "included untrusted input or the text looks like an injected instruction. Do not retry " +
            `it another way. The operator decides with \`kurahi memory quarantine approve ${entry.id}\` ` +
            "or `reject`.",
        });
      }
      const result = await execute(toolCallId, params, signal, onUpdate);
      record(ctx, base, plan);
      if (flagReasons.length > 0) {
        log.warn(
          `memory write flagged (mode warn, would be quarantined under enforce): ${name} ${paths.join(", ")}`,
        );
        void auditSafe({
          identity: ctx.turn.agentId,
          scope: ctx.turn.sessionKey,
          action: "memory.write.flagged",
          outcome: "warn",
          source: "memory.provenance",
          detail: { tool: name, paths, trust: base.trust, reasons: flagReasons },
        });
      }
      return result;
    },
  };
}
