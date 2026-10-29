// The reasoning step behind a pluggable interface. The shipped adapter runs a configured CLI
// backend (codex-cli or claude-cli, resolved like the agent CLI runner) with NO tools: the
// permission plan for capability `none` (codex: read-only sandbox, host config ignored; claude:
// --restricted, --tools "", strict MCP config), a fresh empty working folder, no session, no
// workspace bootstrap files. If the CLI still reports a tool call, the output is discarded.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { KoLoConfig } from "../config/config.js";
import { resolveCliBackendConfig } from "../agents/cli-backends.js";
import { auditCliPermissionPlan, planCliPermissions } from "../agents/cli-permissions.js";
import {
  buildCliArgs,
  enqueueCliRun,
  normalizeCliModel,
  parseCliJson,
  parseCliJsonl,
  resolvePromptInput,
} from "../agents/cli-runner/helpers.js";
import { runCommandWithTimeout } from "../process/exec.js";

export type ReasonRequest = {
  prompt: string;
  backend: string | null;
  model: string | null;
  timeoutMs: number;
  runId: string;
  routineId: string;
};

export type ReasonResult = { text: string; backend: string; model: string | null };

/** The backend reported a tool call: the output is discarded (the watchdog counts repeats). */
export class ReasonerToolUse extends Error {}

export interface Reasoner {
  reason(req: ReasonRequest): Promise<ReasonResult>;
}

/** Backends whose tool-less mode is verified (cli-permissions.ts); others are refused. */
const TOOL_LESS_BACKENDS = new Set(["codex-cli", "claude-cli"]);
export const DEFAULT_REASONING_BACKEND = "codex-cli";
/** Every reasoning backend a routine may name: the tool-less CLIs and the model API (api-reasoner.ts). */
export const REASONING_BACKENDS = new Set([...TOOL_LESS_BACKENDS, "api"]);

export function createCliReasoner(
  cfg: KoLoConfig,
  deps: { run?: typeof runCommandWithTimeout } = {},
): Reasoner {
  const run = deps.run ?? runCommandWithTimeout;
  return {
    async reason(req) {
      const backendId = (req.backend ?? DEFAULT_REASONING_BACKEND).trim().toLowerCase();
      if (!TOOL_LESS_BACKENDS.has(backendId)) {
        throw new Error(`reasoning backend ${backendId} has no verified tool-less mode`);
      }
      const resolved = resolveCliBackendConfig(backendId, cfg);
      if (!resolved) {
        throw new Error(`reasoning backend ${backendId} is not configured`);
      }
      // The bypass opt-in never applies to autopilot reasoning.
      const backend = { ...resolved.config, unsafeSkipPermissions: false };
      const plan = planCliPermissions({
        backendId: resolved.id,
        backend,
        capability: "none",
        baseArgs: backend.args ?? [],
      });
      auditCliPermissionPlan(plan, {
        backendId: resolved.id,
        agentId: `autopilot:${req.routineId}`,
        sessionKey: `autopilot:${req.runId}`,
      });
      const { argsPrompt, stdin } = resolvePromptInput({ backend, prompt: req.prompt });
      const model = req.model ? normalizeCliModel(req.model, backend) : "";
      const args = buildCliArgs({
        backend,
        baseArgs: plan.args,
        modelId: model,
        systemPrompt: null,
        promptArg: argsPrompt,
        useResume: false,
      });
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries({ ...process.env, ...backend.env })) {
        if (typeof v === "string" && !(backend.clearEnv ?? []).includes(k)) {
          env[k] = v;
        }
      }
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autopilot-"));
      try {
        const result = await enqueueCliRun(
          backend.serialize === false ? `${resolved.id}:${req.runId}` : resolved.id,
          () =>
            run([backend.command, ...args], {
              timeoutMs: req.timeoutMs,
              cwd: work,
              env,
              input: stdin ?? "",
            }),
        );
        if (result.code !== 0) {
          throw new Error(
            `reasoning run failed (exit ${result.code ?? "?"}): ${(result.stderr || result.stdout).trim().slice(0, 200)}`,
          );
        }
        const stdout = result.stdout.trim();
        const parsed =
          backend.output === "jsonl"
            ? parseCliJsonl(stdout, backend)
            : backend.output === "json"
              ? parseCliJson(stdout, backend)
              : { text: stdout };
        if (parsed?.toolCalls?.length) {
          throw new ReasonerToolUse(
            `reasoning backend reported tool use (${parsed.toolCalls.slice(0, 3).join(", ")}); output discarded`,
          );
        }
        if (!parsed?.text) {
          // No answer message: never hand the raw event stream to the plan parser. Name the
          // backend's own error items instead (e.g. usage limit, sign-in), bounded.
          throw new Error(
            `reasoning backend returned no answer${backendErrors(stdout) ? `: ${backendErrors(stdout)}` : ""}`,
          );
        }
        return { text: parsed.text, backend: resolved.id, model: model || null };
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    },
  };
}

/** Error items of a JSONL event stream (codex `item.type: "error"`), joined and bounded. */
function backendErrors(stdout: string): string {
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    try {
      const e = JSON.parse(line) as { item?: { type?: unknown; message?: unknown } };
      if (e.item?.type === "error" && typeof e.item.message === "string") {
        out.push(e.item.message);
      }
    } catch {
      // not an event line
    }
  }
  return out.join(" | ").slice(0, 300);
}
