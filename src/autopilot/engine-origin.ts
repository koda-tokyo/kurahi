// The invocation origin of a tool call the autopilot ENGINE makes (gather, or an allowed action).
// The engine runs each of its tool calls inside this async context; a model or an agent session
// never can: the context is not a tool argument, it is set only by engine code
// (gateway-deps.ts → runAsEngine), the same way the exec tool sets KOLO_EXEC_ORIGIN for cron
// runs instead of letting the command claim it. A connector reads it to tell an engine call from
// an agent call (e.g. m365_mail_send under a standing approval, see standing-send.ts).
//
// The storage lives on globalThis under a registered symbol: plugins are loaded through jiti and
// may get their own copy of this module; both copies must see the same context.

import { AsyncLocalStorage } from "node:async_hooks";

export type EngineInvocation = {
  origin: "autopilot";
  projectId: string;
  routineId: string;
  runId: string;
  /** The routine's project session the call runs in (the tool's ctx.sessionKey must match). */
  sessionKey: string;
  /** The tool the engine is calling; a connector refuses the context for any other tool. */
  tool: string;
  /** Catalogue action the call executes (null for a gather step). */
  action: string | null;
  /** L3: the standing approval authorize.ts chose for this call, else null. */
  approvalId: string | null;
  /** Template id the authorized action names (checked against the approval scope). */
  templateId: string | null;
  /** Routine timezone (the approval's daily counter is per routine day). */
  tz: string;
  home?: string;
  /** Set once by the connector that verified and used the approval (single use per call). */
  used: { approvalId: string; usesToday: number } | null;
  /** Set when the connector looked at the approval and fell back to asking a person. */
  fallback: { code: string; reason: string } | null;
};

const KEY = Symbol.for("kurahi.autopilot.engineInvocation");

function storage(): AsyncLocalStorage<EngineInvocation> {
  const g = globalThis as { [KEY]?: AsyncLocalStorage<EngineInvocation> };
  g[KEY] ??= new AsyncLocalStorage<EngineInvocation>();
  return g[KEY];
}

/** Run `fn` as an engine call. Only engine code calls this (never from a tool's arguments). */
export function runAsEngine<T>(inv: EngineInvocation, fn: () => Promise<T>): Promise<T> {
  return storage().run(inv, fn);
}

/** The engine invocation the current call runs under, or null (agent sessions, HTTP, CLI). */
export function currentEngineInvocation(): EngineInvocation | null {
  return storage().getStore() ?? null;
}

/** What the runner knows about one of its tool calls (runner.ts ToolCall.engine). */
export type EngineCallInfo = Pick<
  EngineInvocation,
  "projectId" | "routineId" | "runId" | "action" | "approvalId" | "templateId" | "tz" | "home"
>;

/**
 * Run one engine tool call under its invocation context and report what a connector did with
 * the standing approval (used once, or fell back to asking a person).
 */
export async function invokeAsEngine<T>(
  call: { sessionKey: string; tool: string; engine: EngineCallInfo },
  fn: () => Promise<T>,
): Promise<{ value: T; used: EngineInvocation["used"]; fallback: EngineInvocation["fallback"] }> {
  const inv: EngineInvocation = {
    origin: "autopilot",
    ...call.engine,
    sessionKey: call.sessionKey,
    tool: call.tool,
    used: null,
    fallback: null,
  };
  const value = await runAsEngine(inv, fn);
  return { value, used: inv.used, fallback: inv.fallback };
}
