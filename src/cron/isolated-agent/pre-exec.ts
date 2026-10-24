import type { AnyAgentTool } from "../../agents/pi-tools.types.js";
import type { KoLoConfig } from "../../config/config.js";
import type { CronPreExecOutcome } from "../types.js";
import { createKoLoCodingTools } from "../../agents/pi-tools.js";
import { resolveSandboxContextOrUnavailable } from "../../agents/sandbox.js";

/**
 * A cron job's deterministic pre-step (`payload.preExec`): the runtime runs one command before
 * the model turn, through the agent's own `exec` tool, exactly as if the agent had called exec
 * with only `command`. Same tool policy (exec must be allowed for the agent), host, sandbox,
 * security, allowlist, approvals, hardline guard, policy engine and hooks; nothing is widened.
 * The child sees KOLO_EXEC_ORIGIN=cron so what it records can name the real executor.
 *
 * Unattended: nobody can answer an approval prompt, so a command that needs one is reported as
 * an error (the approval request stays pending for a person; nothing runs unless they approve).
 */
export type CronPreExecResult = CronPreExecOutcome & {
  /** Combined output (capped), handed to the model turn. Not persisted by the run log. */
  output?: string;
};

export const PRE_EXEC_OUTPUT_MAX_CHARS = 4000;
const HEAD_MAX_CHARS = 300;

function firstLine(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) {
    return undefined;
  }
  return line.length > HEAD_MAX_CHARS ? `${line.slice(0, HEAD_MAX_CHARS)}…` : line;
}

function capOutput(text: string): string {
  return text.length > PRE_EXEC_OUTPUT_MAX_CHARS
    ? `${text.slice(0, PRE_EXEC_OUTPUT_MAX_CHARS)}\n…(output truncated)`
    : text;
}

export async function runCronPreExec(params: {
  command: string;
  cfg: KoLoConfig;
  agentId: string;
  sessionKey: string;
  workspaceDir: string;
  agentDir?: string;
  abortSignal?: AbortSignal;
  /** Test seam: the agent tool list. */
  createTools?: (opts: Parameters<typeof createKoLoCodingTools>[0]) => AnyAgentTool[];
  nowMs?: () => number;
}): Promise<CronPreExecResult> {
  const now = params.nowMs ?? Date.now;
  const started = now();
  const elapsed = () => Math.max(0, now() - started);
  const command = params.command.trim();
  if (!command) {
    return { status: "error", error: "preExec: empty command", durationMs: 0 };
  }
  let exec: AnyAgentTool | undefined;
  try {
    const { sandbox, unavailable } = await resolveSandboxContextOrUnavailable({
      config: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
    });
    const workspaceDir =
      sandbox?.enabled && sandbox.workspaceAccess !== "rw"
        ? sandbox.workspaceDir
        : params.workspaceDir;
    const tools = (params.createTools ?? createKoLoCodingTools)({
      config: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir,
      agentDir: params.agentDir,
      sandbox,
      sandboxUnavailable: unavailable,
      abortSignal: params.abortSignal,
      exec: { origin: "cron", allowBackground: false },
    });
    exec = tools.find((t) => t.name === "exec");
  } catch (err) {
    return { status: "error", error: `preExec: ${String(err)}`, durationMs: elapsed() };
  }
  if (!exec) {
    return {
      status: "error",
      error: `preExec: the exec tool is not available to agent ${params.agentId} (tool policy)`,
      durationMs: elapsed(),
    };
  }
  try {
    const res = await exec.execute(`cron-pre-exec-${started}`, { command }, params.abortSignal);
    const details = (res.details ?? {}) as { status?: string; exitCode?: number | null };
    const text = (res.content ?? [])
      .map((c: { type: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : ""))
      .join("\n");
    if (details.status === "approval-pending") {
      return {
        status: "error",
        error:
          "preExec: the command needs an approval and cron runs unattended; it did not run " +
          "(the approval request stays pending)",
        durationMs: elapsed(),
      };
    }
    if (details.status !== "completed") {
      return {
        status: "error",
        error: `preExec: exec returned status ${details.status ?? "unknown"}`,
        head: firstLine(text),
        durationMs: elapsed(),
      };
    }
    return {
      status: "ok",
      exitCode: details.exitCode ?? 0,
      head: firstLine(text),
      output: capOutput(text),
      durationMs: elapsed(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The exec tool rejects a command that ran and failed with "<output>\n\nCommand exited with
    // code N" (or timed out / was aborted by a signal). Anything else means it never ran.
    const ran =
      /\n?\n?(Command exited with code (-?\d+)|Command timed out after \d+ seconds|Command aborted by signal \S+|Command aborted before exit code was captured)$/.exec(
        message,
      );
    if (ran) {
      const output = message.slice(0, ran.index);
      return {
        status: "failed",
        exitCode: ran[2] !== undefined ? Number(ran[2]) : null,
        head: firstLine(output),
        output: capOutput(output),
        error: ran[1],
        durationMs: elapsed(),
      };
    }
    const reason = message.split("\n")[0] ?? message;
    return {
      status: "error",
      error: `preExec refused: ${reason.length > 400 ? `${reason.slice(0, 400)}…` : reason}`,
      durationMs: elapsed(),
    };
  }
}

/**
 * payload.preExec.pinHead: the pre-step's first output line is the job's whole operational output.
 * The model's reply never reaches a person; run.ts keeps it only as preExec.modelSummary.
 */
export function pinHeadPayloads(head: string): Array<{ text: string }> {
  return [{ text: head }];
}

/** The model turn's prompt after a pre-step: the job message plus the command's real output. */
export function buildPreExecPrompt(message: string, command: string, res: CronPreExecResult) {
  const exit = res.status === "ok" ? "exit 0" : (res.error ?? "failed");
  return (
    `${message}\n\n` +
    `The runtime already ran this job's command (${exit}); do not run it again.\n` +
    `$ ${command}\n` +
    "```\n" +
    `${(res.output ?? "").trim() || "(no output)"}\n` +
    "```"
  );
}
