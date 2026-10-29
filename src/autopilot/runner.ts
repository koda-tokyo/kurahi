// One routine run: gather (READ tools, deterministic) → reason (tool-less model) → validate →
// authorize each proposed action → execute the allowed ones through the tool path → queue the
// rest for a person → write the signed run record. The model's output is data: it never chooses
// a tool, a level or an approval; the engine does, from the routine and the policy check.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { KoLoConfig } from "../config/config.js";
import type { Project } from "../projects/types.js";
import type { EngineCallInfo } from "./engine-origin.js";
import type { KnowledgeFile } from "./knowledge.js";
import type { GatheredSource } from "./reasoning.js";
import type {
  ActionOutcome,
  AutonomyChange,
  PlanItem,
  Routine,
  RunCounts,
  RunRecord,
  RunStatus,
  RunTrigger,
  RunWatchdog,
} from "./types.js";
import type { EmailOriginRef, WorkItemSink } from "./workitems-adapter.js";
import { auditSafe } from "../audit/audit-log.js";
import { emitAutopilotRun } from "../infra/governance-events.js";
import { projectSessionKey } from "../projects/scope.js";
import { isAgentAllowed } from "../projects/store.js";
import { executeAction, type ItemContext } from "./act.js";
import { type ActionDef, cleanActionArgs, getActionDef } from "./actions.js";
import { EmptyKnowledgeArg, resolveArgs, routineUsesKnowledgeArgs } from "./args.js";
import { authorizeAction } from "./authorize.js";
import { auditDemotion, demoteLocked, routineLevel } from "./autonomy-level.js";
import { briefPlan, isBriefRoutine } from "./brief.js";
import { globalStopRefusal } from "./control.js";
import { MAIL_READ_TOOLS, parseListHeaders, safeEmailOrigin } from "./email-origin.js";
import { engineToolNoInput, isEngineTool, runEngineTool } from "./engine-tools.js";
import { writeRunEvidence } from "./evidence.js";
import { KnowledgeRefused, loadKnowledge } from "./knowledge.js";
import { type Reasoner, ReasonerToolUse } from "./reasoner.js";
import { buildPrompt, parsePlan } from "./reasoning.js";
import { loadRoutines } from "./routines.js";
import {
  approvalUsesOn,
  newId,
  readApprovals,
  readRun,
  routineState,
  runDir,
  updateRoutineState,
  writeRun,
} from "./store.js";
import { gatherToolRefusal, readToolDef } from "./tools.js";
import { AutopilotRefused, BLOCKING_FLAGS } from "./types.js";
import {
  evaluateWatchdog,
  GATHER_TEXT_MAX,
  measurePlan,
  type RunMetrics,
  WATCHDOG_HISTORY_MAX,
} from "./watchdog.js";

export type ToolCall = {
  sessionKey: string;
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  source: string;
  /** The engine invocation the call runs under (set by the runner, never by the model). */
  engine: EngineCallInfo;
};
export type ToolCallResult =
  | {
      ok: true;
      text: string;
      pluginId: string | null;
      /** The tool result's `details` (ids the next action of the item needs). */
      details?: Record<string, unknown>;
      /** L3: the standing approval a connector verified and used for this call. */
      approvalUsed?: string | null;
      /** L3: why a connector asked a person instead of using the standing approval. */
      approvalFallback?: { code: string; reason: string } | null;
    }
  | { ok: false; error: string };
export type ToolInvoker = (call: ToolCall) => Promise<ToolCallResult>;

export type RunnerDeps = {
  cfg: KoLoConfig;
  reasoner: Reasoner;
  tools: ToolInvoker;
  workItems: WorkItemSink;
  defaultAgentId: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Kill switch: a reason when the agent (or the fleet) is stopped, else null. */
  killed?: (agentId: string) => string | null;
  /** Load the session's tools (and so its project plugins, e.g. office spec parsers). */
  ensureTools?: (sessionKey: string) => void;
};

const MAX_TOOL_TEXT = GATHER_TEXT_MAX;
const BLOCKING = new Set<string>(BLOCKING_FLAGS);

/** 0 for the work-item intake (authorized before the item's other actions), else 1. */
function intakeRank(kind: string): number {
  return getActionDef(kind)?.executor === "workitem" ? 0 : 1;
}
/** Routine runs in progress in this process → settles when the run ends (either way). */
const running = new Map<string, Promise<void>>();

/** The run in progress for the routine, or null (the trigger dispatcher waits on it). */
export function routineRunInProgress(projectId: string, routineId: string): Promise<void> | null {
  return running.get(`${projectId}/${routineId}`) ?? null;
}

/** How a run was started. Event runs name the sources whose signals they coalesced. */
export type RunTriggerInput = { kind: RunTrigger; by: string; sources?: string[] };

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

/** A stable project chat id for the routine's session (`proj-<projectId>-<chatId>`). */
export function routineChatId(routineId: string): string {
  return `ap${sha256(routineId).slice(0, 12)}`;
}

export function routineSessionKey(agentId: string, projectId: string, routineId: string): string {
  return projectSessionKey(agentId, projectId, routineChatId(routineId));
}

export function routineTimezone(routine: Routine): string {
  const t = routine.trigger;
  return t.kind === "schedule" || t.kind === "event" ? t.tz : "Asia/Tokyo";
}

export function dayKey(now: Date, tz: string): string {
  return now.toLocaleDateString("sv-SE", { timeZone: tz });
}

function emptyCounts(): RunCounts {
  return {
    items: 0,
    prepared: 0,
    acted: 0,
    escalated: 0,
    refused: 0,
    failed: 0,
    handled: 0,
    deferred: 0,
  };
}

/** Text of a tool result (`content[].text`), capped. */
export function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  const text = Array.isArray(content)
    ? content
        .map((c) => (typeof c?.text === "string" ? c.text : ""))
        .filter(Boolean)
        .join("\n")
    : typeof result === "string"
      ? result
      : JSON.stringify(result ?? null);
  return text.slice(0, MAX_TOOL_TEXT);
}

export async function runRoutine(
  deps: RunnerDeps,
  project: Project,
  routineId: string,
  trigger: RunTriggerInput,
): Promise<RunRecord> {
  // Global kill switch and emergency STOP file: no routine of any Project runs.
  const stop = globalStopRefusal(deps.home);
  if (stop) {
    throw new AutopilotRefused(stop.code, stop.reason);
  }
  const set = loadRoutines(project, deps.home);
  if (set.error) {
    throw new AutopilotRefused("routines_invalid", `the routines file is invalid: ${set.error}`);
  }
  const routine = set.routines.find((r) => r.id === routineId);
  if (!routine) {
    throw new AutopilotRefused("routine_not_found", "routine not found");
  }
  if (!routine.enabled) {
    throw new AutopilotRefused("routine_disabled", "the routine is disabled in its file");
  }
  if (project.archived) {
    throw new AutopilotRefused("archived", "project is archived");
  }
  const state = routineState(project.id, routine.id, deps.home);
  if (state.paused) {
    throw new AutopilotRefused("paused", `the routine is paused (by ${state.pausedBy ?? "?"})`);
  }
  // A routine that names no agent runs as the gateway's default agent when the Project allows it,
  // else as the first agent the Project allows (a Project limited to its own agents would
  // otherwise refuse every unnamed routine).
  const agentId =
    routine.agentId ??
    (isAgentAllowed(project, deps.defaultAgentId, deps.defaultAgentId)
      ? deps.defaultAgentId
      : (project.allowedAgents[0] ?? deps.defaultAgentId));
  if (!isAgentAllowed(project, agentId, deps.defaultAgentId)) {
    throw new AutopilotRefused(
      "agent_not_allowed",
      `agent ${agentId} may not work in this project`,
    );
  }
  const key = `${project.id}/${routine.id}`;
  if (running.has(key)) {
    throw new AutopilotRefused("already_running", "the routine is already running");
  }
  let done!: () => void;
  running.set(
    key,
    new Promise<void>((resolve) => {
      done = resolve;
    }),
  );
  try {
    return await execute(deps, project, routine, set.digest, agentId, trigger);
  } finally {
    running.delete(key);
    done();
  }
}

async function execute(
  deps: RunnerDeps,
  project: Project,
  routine: Routine,
  routineDigest: string,
  agentId: string,
  trigger: RunTriggerInput,
): Promise<RunRecord> {
  const now = deps.now ?? (() => new Date());
  const started = now();
  const runId = newId("r");
  const sessionKey = routineSessionKey(agentId, project.id, routine.id);
  const state = routineState(project.id, routine.id, deps.home);
  // The effective level (file level lowered by an accepted level or a demotion) is what every
  // action is authorized against; the file's level is only the ceiling.
  const level = routineLevel(routine, state);
  const acting: Routine = { ...routine, level };
  const seen = new Set(state.seen);
  const tz = routineTimezone(routine);
  const today = dayKey(started, tz);
  const day = { actions: state.days[today]?.actions ?? 0 };
  const counts = emptyCounts();
  const outcomes: ActionOutcome[] = [];
  const workItems: string[] = [];
  const gather: RunRecord["gather"] = [];
  const newRefs: string[] = [];
  let status: RunStatus = "ok";
  let reason: string | null = null;
  const reasoning: RunRecord["reasoning"] = {
    backend: routine.reasoning.backend,
    model: routine.reasoning.model,
    ms: 0,
    outputSha256: null,
  };
  const engineInfo = (action: string | null): EngineCallInfo => ({
    projectId: project.id,
    routineId: routine.id,
    runId,
    action,
    approvalId: null,
    templateId: null,
    tz,
    home: deps.home,
  });

  const callTool = async (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; details?: Record<string, unknown> }> => {
    const def = readToolDef(tool);
    const refusal = gatherToolRefusal(tool);
    if (!def || refusal) {
      throw new Error(refusal ?? `${tool} is not a declared read tool`);
    }
    if (def.provider === "engine") {
      if (!isEngineTool(tool)) {
        throw new Error(`${tool} is not an engine check`);
      }
      const text = runEngineTool(tool, args, { projectId: project.id, home: deps.home });
      const noInput = engineToolNoInput(tool, text);
      return { text, ...(noInput ? { details: { noInput: true, noInputReason: noInput } } : {}) };
    }
    const res = await deps.tools({
      sessionKey,
      agentId,
      tool,
      args,
      source: `autopilot:${routine.id}`,
      engine: engineInfo(null),
    });
    if (!res.ok) {
      throw new Error(`${tool}: ${res.error}`);
    }
    // The tool that answered must come from the provider that declared it read-only.
    const expected = def.provider === "core" ? null : def.provider;
    if (res.pluginId !== expected) {
      throw new Error(
        `${tool} is provided by ${res.pluginId ?? "core"}, declared by ${def.provider}`,
      );
    }
    return { text: res.text, details: res.details };
  };

  /** Messages whose attachment the intake refused → the refusal codes (malicious_attachment). */
  const refusedAttachments = new Map<string, string[]>();
  /** Gather source id → the message whose attachment it fetched. */
  const sourceAttachment = new Map<string, string>();
  const noteAttachment = (sourceId: string, details: Record<string, unknown> | undefined) => {
    const a = details?.attachment as
      | { status?: unknown; code?: unknown; messageId?: unknown }
      | undefined;
    if (!a || typeof a.messageId !== "string") {
      return;
    }
    sourceAttachment.set(sourceId, a.messageId);
    if (a.status !== "accepted") {
      const codes = refusedAttachments.get(a.messageId) ?? [];
      codes.push(typeof a.code === "string" ? a.code : "refused");
      refusedAttachments.set(a.messageId, codes);
    }
  };

  const killed = deps.killed?.(agentId) ?? null;
  const sources: GatheredSource[] = [];
  /** Message ids the routine read through a mail connector → the reference intake keeps. */
  const emails = new Map<string, EmailOriginRef>();
  /** Fan-out source id (e.g. `mail.2`) → message id. */
  const sourceMessage = new Map<string, string>();
  /** Message id → the seen keys it was read under. */
  const seenKeysOf = new Map<string, string[]>();
  let knowledge: KnowledgeFile[] = [];
  let items: PlanItem[] = [];
  let reasoned = false;
  let toolUse = false;
  if (killed) {
    status = "skipped";
    reason = `kill switch: ${killed}`;
  } else {
    // ---- approved knowledge (trusted, read-only folder; fail closed) ----
    let knowledgeLoaded = false;
    const loadKnowledgeRow = () => {
      knowledgeLoaded = true;
      const row = {
        id: "knowledge",
        tool: "knowledge",
        calls: 0,
        bytes: 0,
        error: null as string | null,
      };
      gather.push(row);
      try {
        const loaded = loadKnowledge(project, routine.knowledge);
        knowledge = loaded.files;
        row.calls = loaded.files.length;
        row.bytes = loaded.files.reduce((n, f) => n + f.text.length, 0);
        row.error = loaded.missing.length ? `missing: ${loaded.missing.join(", ")}` : null;
      } catch (err) {
        row.error = String(err instanceof Error ? err.message : err).slice(0, 300);
        status = "failed";
        reason = err instanceof KnowledgeRefused ? row.error : `knowledge failed: ${row.error}`;
      }
    };
    // Gather arguments taken from knowledge need the knowledge before the first tool call.
    if (routineUsesKnowledgeArgs(routine)) {
      loadKnowledgeRow();
    }
    /** Argument references (args.ts) resolve against this run: knowledge, last success, now. */
    const argsOf = (step: (typeof routine.gather)[number]) =>
      resolveArgs(
        step.args,
        { knowledge, lastSuccessAt: state.lastSuccessAt, now: started, tz },
        routine.knowledge,
      );
    // ---- gather ----
    const outputs = new Map<string, string>();
    let fanOutCalls = 0;
    let hasFanOut = false;
    /** A gate step reported nothing to process: its reason. */
    let gated: string | null = null;
    /** Mail list step id → the message ids this run read from it (new mail only). */
    const mailListReads = new Map<string, Set<string>>();
    try {
      for (const step of status === "ok" ? routine.gather : []) {
        const row = {
          id: step.id,
          tool: step.tool,
          calls: 0,
          bytes: 0,
          error: null as string | null,
        };
        gather.push(row);
        try {
          const stepArgs = argsOf(step);
          if (step.each) {
            hasFanOut = true;
            const from = outputs.get(step.each.from) ?? "";
            const ids = [
              ...new Set(
                [...from.matchAll(new RegExp(step.each.match, "g"))]
                  .map((m) => m[1])
                  .filter((v): v is string => typeof v === "string" && v.length > 0),
              ),
            ]
              .filter((id) => !seen.has(`${step.id}:${id}`))
              .slice(0, step.each.max);
            const connector = MAIL_READ_TOOLS[step.tool];
            const headers = connector ? parseListHeaders(from) : new Map();
            const parts: string[] = [];
            for (const [n, id] of ids.entries()) {
              const { text, details } = await callTool(step.tool, {
                ...stepArgs,
                [step.each.arg]: id,
              });
              row.calls++;
              row.bytes += text.length;
              const sourceId = `${step.id}.${n + 1}`;
              noteAttachment(sourceId, details);
              sources.push({ id: sourceId, tool: step.tool, text: `ref: ${id}\n${text}` });
              parts.push(text);
              const seenKey = `${step.id}:${id}`;
              newRefs.push(seenKey);
              seenKeysOf.set(id, [...(seenKeysOf.get(id) ?? []), seenKey]);
              if (connector) {
                const origin = safeEmailOrigin(connector, id, headers.get(id));
                if (origin) {
                  emails.set(id, origin);
                  sourceMessage.set(sourceId, id);
                }
              }
            }
            fanOutCalls += ids.length;
            outputs.set(step.id, parts.join("\n"));
            if (connector) {
              const read = mailListReads.get(step.each.from) ?? new Set<string>();
              ids.forEach((id) => read.add(id));
              mailListReads.set(step.each.from, read);
            }
          } else {
            const { text, details } = await callTool(step.tool, stepArgs);
            row.calls++;
            row.bytes += text.length;
            noteAttachment(step.id, details);
            outputs.set(step.id, text);
            sources.push({ id: step.id, tool: step.tool, text });
            if (step.gate && details?.noInput === true) {
              // Nothing to process (e.g. no change since the baseline): no model call.
              const why = details.noInputReason;
              gated = typeof why === "string" && why ? why.slice(0, 200) : "nothing new to process";
              break;
            }
          }
        } catch (err) {
          row.error = String(err instanceof Error ? err.message : err).slice(0, 300);
          throw err;
        }
      }
    } catch (err) {
      if (err instanceof EmptyKnowledgeArg) {
        // Nothing to search for yet (e.g. an empty research profile): not a failure.
        status = "no_input";
        reason = err.message.slice(0, 300);
      } else {
        status = "failed";
        reason = `gather failed: ${String(err instanceof Error ? err.message : err).slice(0, 300)}`;
      }
    }
    // The reasoner sees only the list entries of mail read in this run: messages seen before are
    // already carried by an item, and re-planning them costs time and quota on every trigger.
    for (const [listId, read] of mailListReads) {
      const src = sources.find((x) => x.id === listId);
      if (src) {
        src.text = keepListEntries(src.text, read);
      }
    }
    if (status === "ok" && hasFanOut && fanOutCalls === 0) {
      status = "no_input";
      reason = "nothing new to process";
    }
    if (status === "ok" && gated !== null) {
      status = "no_input";
      reason = gated;
    }
    if (status === "ok" && routine.knowledge.length > 0 && !knowledgeLoaded) {
      loadKnowledgeRow();
    }
    // ---- reason (or the engine's own plan: a brief routine calls no model) ----
    if (status === "ok" && isBriefRoutine(routine)) {
      const t0 = Date.now();
      try {
        items = briefPlan(project, deps.home);
        reasoning.backend = "engine";
        reasoning.model = null;
        reasoning.outputSha256 = sha256(JSON.stringify(items));
        reasoned = true;
      } catch (err) {
        status = "failed";
        reason = `brief plan failed: ${String(err instanceof Error ? err.message : err).slice(0, 280)}`;
      }
      reasoning.ms = Date.now() - t0;
    } else if (status === "ok") {
      const t0 = Date.now();
      try {
        const ask = (extra: string) =>
          deps.reasoner.reason({
            prompt: buildPrompt(routine, sources, knowledge, today) + extra,
            backend: routine.reasoning.backend,
            model: routine.reasoning.model,
            timeoutMs: routine.reasoning.timeoutSeconds * 1000,
            runId,
            routineId: routine.id,
          });
        let out = await ask("");
        reasoning.backend = out.backend;
        reasoning.model = out.model;
        reasoning.outputSha256 = sha256(out.text);
        try {
          items = parsePlan(out.text, routine.reasoning.schemaId);
        } catch (first) {
          if (first instanceof ReasonerToolUse) {
            throw first;
          }
          // One retry for a malformed reply (seen live: a plan missing its closing brackets).
          // Same prompt, same strict validation; no partial plan ever runs.
          const why = String(first instanceof Error ? first.message : first).slice(0, 120);
          out = await ask(
            `\n\nYour previous reply was rejected (${why}). Reply again with the COMPLETE JSON object only.`,
          );
          reasoning.outputSha256 = sha256(out.text);
          reasoning.retried = true;
          try {
            items = parsePlan(out.text, routine.reasoning.schemaId);
          } catch (err) {
            // Keep the rejected reply next to the run (owner-only, bounded) so an administrator
            // can see why the plan was refused. It stays on this machine like the run record.
            const dir = runDir(project.id, runId, deps.home);
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            fs.writeFileSync(path.join(dir, "rejected-output.txt"), out.text.slice(0, 64 * 1024), {
              mode: 0o600,
            });
            throw err;
          }
        }
        reasoned = true;
      } catch (err) {
        toolUse = err instanceof ReasonerToolUse;
        status = "failed";
        reason = String(err instanceof Error ? err.message : err).slice(0, 300);
      }
      reasoning.ms = Date.now() - t0;
    }
  }

  /** The email an item is about: its ref, or the one email source it cites. */
  const originOf = (item: PlanItem): EmailOriginRef | undefined => {
    const byRef = emails.get(item.ref);
    if (byRef) {
      return byRef;
    }
    const cited = [...new Set(item.sources.map((s) => sourceMessage.get(s)).filter(Boolean))];
    return cited.length === 1 ? emails.get(cited[0]!) : undefined;
  };
  /** Messages whose item reached its end (queued or done): seen even when the run fails. */
  const completed = new Set<string>();
  const sourceIds = new Set(sources.map((s) => s.id));
  const sourcesById = new Map(sources.map((s) => [s.id, s]));
  /** Messages of an item whose attachment the intake refused. */
  const refusedMessagesOf = (item: PlanItem): string[] => {
    const ids = new Set<string>();
    const candidates = [
      item.ref,
      originOf(item)?.messageId,
      ...item.sources.map((s) => sourceAttachment.get(s) ?? sourceMessage.get(s)),
    ];
    for (const id of candidates) {
      if (id && refusedAttachments.has(id)) {
        ids.add(id);
      }
    }
    return [...ids];
  };
  /** The model's flags plus the engine's own (citations, refused attachments). */
  const flagsOf = (item: PlanItem): PlanItem["flags"] => {
    const flags = [...item.flags];
    if (
      routine.requireCitations &&
      (item.sources.length === 0 || item.sources.some((s) => !sourceIds.has(s))) &&
      !flags.includes("unverified_citation")
    ) {
      flags.push("unverified_citation");
    }
    if (refusedMessagesOf(item).length > 0 && !flags.includes("malicious_attachment")) {
      flags.push("malicious_attachment");
    }
    return flags;
  };
  const approvals = status === "ok" ? readApprovals(project.id, deps.home) : [];

  // ---- behaviour watchdog: measured and judged before any action runs ----
  const toolUseStreak = toolUse
    ? state.watchdog.toolUseStreak + 1
    : reasoned
      ? 0
      : state.watchdog.toolUseStreak;
  let metrics: RunMetrics | null = null;
  let watch: ReturnType<typeof evaluateWatchdog> | null = null;
  if (status === "ok" || toolUse) {
    let signals = { refusals: 0, offRoutine: [] as string[] };
    if (status === "ok") {
      const m = measurePlan({
        items,
        gather,
        flagsOf,
        authorize: (action, flags) =>
          authorizeAction(acting, action, {
            now: now(),
            flags,
            approvals,
            actionsToday: day.actions,
            approvalUsesToday: {},
          }),
        runId,
        startedAt: started,
        now: now(),
      });
      metrics = m.metrics;
      signals = m;
    }
    watch = evaluateWatchdog(routine, state.watchdog.history, metrics, {
      refusals: signals.refusals,
      offRoutine: signals.offRoutine,
      toolUseStreak,
    });
  }
  /** Tripped: nothing is executed; every allowed action waits for a person. */
  const hold = watch?.tripped === true;
  // The global stop may have been set while this run gathered and reasoned.
  const stoppedNow = status === "ok" ? globalStopRefusal(deps.home) : null;
  if (stoppedNow) {
    status = "skipped";
    reason = `${stoppedNow.code}: ${stoppedNow.reason}`;
  }
  /** Messages with a refused attachment that an item covered (else they get their own item). */
  const coveredAttachments = new Set<string>();

  // ---- authorize + act ----
  if (status === "ok") {
    let sinkFailed = false;
    counts.deferred = Math.max(0, items.length - routine.limits.maxItemsPerRun);
    for (const [index, item] of items.slice(0, routine.limits.maxItemsPerRun).entries()) {
      const origin = originOf(item);
      // Idempotency with intake: a message this routine already filed is not acted on again
      // (a retried run, a reset state), whatever the plan proposes.
      const prior = origin ? (deps.workItems.handled?.(project, routine, origin) ?? null) : null;
      if (prior) {
        for (const action of item.actions) {
          outcomes.push({
            item: item.ref,
            kind: action.kind,
            class: getActionDef(action.kind)?.class ?? null,
            decision: "refuse",
            code: "already_handled",
            executed: false,
            error: null,
            approvalId: null,
            ref: prior.id,
          });
        }
        completed.add(origin!.messageId);
        continue;
      }
      counts.items++;
      const flags = flagsOf(item);
      for (const id of refusedMessagesOf(item)) {
        coveredAttachments.add(id);
      }
      const it: PlanItem = { ...item, flags };
      const pending: string[] = [];
      const never: string[] = [];
      const ctx: ItemContext = {
        index: index + 1,
        origin,
        draftId: null,
        documentPath: null,
        documents: [],
        fields: {},
      };
      let intake: Record<string, unknown> | null = null;
      let intakeOutcome: ActionOutcome | null = null;
      let executedAny = false;
      const afterIntake: Array<{
        def: ActionDef;
        args: Record<string, unknown>;
        outcome: ActionOutcome;
      }> = [];
      /** Execute one allowed action; false when it failed (the outcome carries the error). */
      const execute = async (
        def: ActionDef,
        args: Record<string, unknown>,
        outcome: ActionOutcome,
      ): Promise<boolean> => {
        try {
          const done = await executeAction(
            {
              deps,
              project,
              routine,
              runId,
              sessionKey,
              agentId,
              engine: { ...engineInfo(def.id), approvalId: outcome.approvalId },
              workItems,
            },
            def,
            args,
            it,
            ctx,
          );
          outcome.ref = done.ref;
          // L3: the approval the connector actually used (null: a person approved instead).
          if (outcome.approvalId) {
            outcome.approvalId = done.approvalUsed;
            if (!done.approvalUsed) {
              // The connector's reason (audited as autopilot.approval.use, denied) stays there.
              outcome.code = "person_approved";
            }
          }
          outcome.executed = true;
          if (def.class === "prepare") {
            counts.prepared++;
          } else {
            counts.acted++;
          }
          day.actions++;
          return true;
        } catch (err) {
          outcome.error = String(err instanceof Error ? err.message : err).slice(0, 300);
          counts.failed++;
          return false;
        }
      };
      /** Budget held by allowed actions that run later (the intake, afterIntake actions). */
      let reserved = 0;
      // The intake is authorized first: under a tight daily limit the filing wins over the
      // actions that depend on it.
      const ordered = item.actions.toSorted((a, b) => intakeRank(a.kind) - intakeRank(b.kind));
      for (const action of ordered) {
        const decision = authorizeAction(acting, action, {
          now: now(),
          flags,
          approvals,
          actionsToday: day.actions + reserved,
          // The one counter (approval-uses.json), read fresh: a send may have used one.
          approvalUsesToday: approvalUsesOn(project.id, today, deps.home),
        });
        const outcome: ActionOutcome = {
          item: item.ref,
          kind: action.kind,
          class: decision.class,
          decision: decision.decision,
          code: decision.decision === "allow" ? null : decision.code,
          executed: false,
          error: null,
          approvalId: decision.decision === "allow" ? decision.approvalId : null,
          ref: null,
        };
        outcomes.push(outcome);
        if (decision.decision === "refuse") {
          counts.refused++;
          continue;
        }
        if (decision.decision === "needs_person") {
          pending.push(`${action.kind}: ${decision.reason}`);
          if (decision.class === "never") {
            never.push(action.kind);
          }
          continue;
        }
        if (hold) {
          outcome.decision = "needs_person";
          outcome.code = "watchdog_hold";
          outcome.approvalId = null;
          pending.push(`${action.kind}: held by the behaviour watchdog; a person decides`);
          continue;
        }
        const def = getActionDef(action.kind)!;
        const cleaned = cleanActionArgs(def, action.args);
        const args = cleaned.ok ? cleaned.args : {};
        if (def.executor === "workitem") {
          // Executed after the other actions, so a pending reason can travel with the item.
          intake = args;
          intakeOutcome = outcome;
          reserved++;
          continue;
        }
        if (def.executor === "none") {
          outcome.decision = "needs_person";
          outcome.code = "no_executor";
          pending.push(`${action.kind}: no executor on this gateway; a person does it`);
          continue;
        }
        if (def.afterIntake) {
          // Runs once the item's work item is filed (below), never before.
          afterIntake.push({ def, args, outcome });
          reserved++;
          continue;
        }
        if (await execute(def, args, outcome)) {
          executedAny = true;
        } else {
          pending.push(`${action.kind}: failed (${outcome.error})`);
        }
      }
      const blocked = flags.filter((f) => BLOCKING.has(f));
      const awaiting = blocked.length
        ? `flagged (${blocked.join(", ")}): a person decides`
        : pending.length
          ? `${pending.length} action(s) wait for a person`
          : null;
      let reached = true;
      let filed: string | null = null;
      try {
        if (awaiting || intake) {
          const created = deps.workItems.create({
            project,
            routine,
            runId,
            item: it,
            kind: awaiting ? "escalation" : "intake",
            title: typeof intake?.title === "string" ? intake.title : undefined,
            type: typeof intake?.type === "string" ? intake.type : undefined,
            priority: typeof intake?.priority === "string" ? intake.priority : undefined,
            note: typeof intake?.note === "string" ? intake.note : undefined,
            department: typeof intake?.department === "string" ? intake.department : undefined,
            awaitingPerson: awaiting,
            pending,
            never,
            ...(ctx.documents.length ? { documents: [...new Set(ctx.documents)] } : {}),
            ...(origin ? { origin } : {}),
            fields: {
              // What the item rests on: the retrieved sources it cites (engine-checked), and
              // the document its office.create wrote.
              ...evidenceFields(it, sourcesById),
              ...(ctx.documentPath ? { autopilotDocument: ctx.documentPath } : {}),
              // Figures a tool computed for this item (e.g. the quotation's totals).
              ...ctx.fields,
            },
          });
          workItems.push(created.id);
          filed = created.id;
          if (intakeOutcome) {
            intakeOutcome.executed = true;
            intakeOutcome.ref = created.id;
            if (created.created === false) {
              intakeOutcome.code = "existing_item";
            }
            day.actions++;
          }
          if (awaiting) {
            counts.escalated++;
          } else {
            counts.prepared++;
            executedAny = true;
          }
        }
      } catch (err) {
        reached = false;
        counts.failed++;
        if (intakeOutcome) {
          intakeOutcome.error = String(err instanceof Error ? err.message : err).slice(0, 300);
        }
        sinkFailed = true;
        reason = `work item intake failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`;
      }
      // Actions that follow the filing (legacy.baseline_advance): only once a person has the item.
      for (const { def, args, outcome } of afterIntake) {
        if (!filed) {
          outcome.code = "not_filed";
          outcome.error = `${def.id} runs only after this item's work item is filed; none was filed`;
          counts.failed++;
          continue;
        }
        if (await execute(def, args, outcome)) {
          executedAny = true;
        }
      }
      if (reached && origin) {
        completed.add(origin.messageId);
      }
      if (executedAny && !awaiting) {
        counts.handled++;
      }
    }
    // A message whose attachment the intake refused reaches a person even when no item of
    // the plan is about it (the model may have ignored it).
    for (const [messageId, codes] of refusedAttachments) {
      if (coveredAttachments.has(messageId)) {
        continue;
      }
      const origin = emails.get(messageId);
      try {
        const created = deps.workItems.create({
          project,
          routine,
          runId,
          item: {
            ref: messageId,
            title: "Attachment refused by the intake",
            summary: `An attachment of this message was refused (${[...new Set(codes)].join(", ")}). Nothing was stored; review the message in the mail client.`,
            category: null,
            priority: "high",
            flags: ["malicious_attachment"],
            sources: [],
            actions: [],
          },
          kind: "escalation",
          awaitingPerson: "flagged (malicious_attachment): a person decides",
          pending: [],
          ...(origin ? { origin } : {}),
        });
        workItems.push(created.id);
        counts.escalated++;
        if (origin) {
          completed.add(origin.messageId);
        }
      } catch (err) {
        sinkFailed = true;
        reason = `work item intake failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`;
      }
    }
    if (counts.escalated > 0) {
      status = "escalated";
    }
    // An item that could not reach the queue reached nobody: the run failed.
    if (sinkFailed) {
      status = "failed";
    }
  }

  // ---- watchdog trip: one work item with the anomaly; the routine pauses below ----
  if (watch?.tripped) {
    const summary = watch.reasons.join("; ");
    try {
      const created = deps.workItems.create({
        project,
        routine,
        runId,
        item: {
          ref: `watchdog:${runId}`,
          title: `Autopilot watchdog paused routine ${routine.id}`,
          summary: `The behaviour watchdog paused this routine before any action ran: ${summary}. Review the run, then resume the routine with a written reason.`,
          category: null,
          priority: "high",
          flags: [],
          sources: [],
          actions: [],
        },
        kind: "escalation",
        awaitingPerson: `behaviour watchdog: ${summary}`.slice(0, 500),
        pending: watch.reasons,
      });
      workItems.push(created.id);
    } catch (err) {
      reason = `watchdog escalation failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`;
    }
    if (status === "ok") {
      status = "escalated";
    }
    if (hold) {
      reason = `watchdog: ${summary}`.slice(0, 300);
    }
  }
  const runWatchdog: RunWatchdog | null = watch
    ? {
        tripped: watch.tripped,
        reasons: watch.reasons,
        baseline: watch.thresholds.source,
        metrics: metrics
          ? {
              gatherCalls: metrics.gatherCalls,
              bytesRead: metrics.bytesRead,
              items: metrics.items,
              actions: metrics.actions,
              durationMs: metrics.durationMs,
            }
          : null,
      }
    : null;

  const record: RunRecord = {
    id: runId,
    projectId: project.id,
    routineId: routine.id,
    edition: routine.edition,
    area: routine.area,
    level,
    trigger: trigger.kind,
    triggeredBy: trigger.by,
    ...(trigger.kind === "event" && trigger.sources?.length
      ? { triggerSources: [...new Set(trigger.sources)].slice(0, 20) }
      : {}),
    startedAt: started.toISOString(),
    endedAt: now().toISOString(),
    status,
    reason,
    routineDigest,
    gather,
    reasoning,
    counts,
    actions: outcomes,
    workItems,
    evidence: null,
    watchdog: runWatchdog,
  };
  const prevRoot = state.lastRunId
    ? (readRun(project.id, state.lastRunId, deps.home)?.evidence?.root ?? null)
    : null;
  record.evidence = writeRunEvidence(record, prevRoot, { home: deps.home, env: deps.env });
  writeRun(record, deps.home);
  emitAutopilotRun(deps.cfg, record);
  // A failed run leaves its inputs unseen so the next run retries them, except the messages
  // whose item already reached the queue (or was handled before): acting on them again would
  // duplicate drafts. Intake's own idempotency (one item per message) covers the rest.
  // A held (watchdog) or stopped run is treated the same way: nothing was acted on.
  const keep =
    status === "failed" || hold || stoppedNow
      ? [...completed].flatMap((id) => seenKeysOf.get(id) ?? [])
      : newRefs;
  const tripped = watch?.tripped === true;
  const demoted: { change?: AutonomyChange } = {};
  updateRoutineState(
    project.id,
    routine.id,
    (prev) => {
      // A trip also drops the routine one level now (safe direction; raising needs a person).
      const cur = tripped
        ? (() => {
            const out = demoteLocked(
              project.id,
              routine,
              prev,
              {
                cause: "watchdog",
                by: "watchdog",
                reason: `watchdog: ${watch!.reasons.join("; ")}`,
                runId,
                itemId: null,
              },
              { home: deps.home, env: deps.env, at: record.endedAt },
            );
            demoted.change = out.change;
            return out.next;
          })()
        : prev;
      return {
        ...cur,
        seen: [...cur.seen, ...keep.filter((k) => !cur.seen.includes(k))],
        days: { ...cur.days, [today]: day },
        lastRunId: runId,
        lastRunAt: record.endedAt,
        lastStatus: status,
        // The `lastRun` gather variable: only a run whose gather completed and whose work
        // reached the queue moves it (a held, stopped or failed run is read again).
        lastSuccessAt:
          (status === "ok" || status === "escalated" || status === "no_input") &&
          !hold &&
          !stoppedNow
            ? record.startedAt
            : cur.lastSuccessAt,
        watchdog: {
          ...cur.watchdog,
          // Tripped runs never become the baseline.
          history:
            metrics && !tripped
              ? [...cur.watchdog.history, metrics].slice(-WATCHDOG_HISTORY_MAX)
              : cur.watchdog.history,
          toolUseStreak: tripped ? 0 : toolUseStreak,
          ...(tripped
            ? {
                lastTrip: { at: record.endedAt, runId, reasons: watch!.reasons },
                trips: cur.watchdog.trips + 1,
              }
            : {}),
        },
        ...(tripped
          ? {
              paused: true,
              pausedBy: "watchdog",
              pausedAt: record.endedAt,
              pauseReason: `watchdog: ${watch!.reasons.join("; ")}`.slice(0, 1000),
            }
          : {}),
      };
    },
    deps.home,
  );
  if (demoted.change) {
    auditDemotion(demoted.change);
  }
  if (tripped) {
    void auditSafe({
      identity: `autopilot:${routine.id}`,
      scope: project.id,
      action: "autopilot.watchdog.trip",
      outcome: "denied",
      source: "autopilot.watchdog",
      detail: {
        routineId: routine.id,
        runId,
        reasons: watch!.reasons,
        baseline: watch!.thresholds.source,
        workItems,
      },
    });
  }
  return record;
}

const BOUNDARY_RE = /<<<\s*(?:END_)?EXTERNAL_UNTRUSTED_CONTENT\s*>>>/i;

/**
 * The evidence of an item: each cited SOURCE that was retrieved in this run, with its tool and
 * the first meaningful line (`ref: <id>` for a fan-out source). Sources the run did not retrieve
 * are not listed (the item is flagged unverified_citation instead). Bounded.
 */
export function evidenceFields(
  item: PlanItem,
  sources: ReadonlyMap<string, GatheredSource>,
): Record<string, string> {
  const lines: string[] = [];
  for (const id of [...new Set(item.sources)].slice(0, 20)) {
    const src = sources.get(id);
    if (!src) {
      continue;
    }
    const text = src.text.split("\n").map((l) => l.trim());
    // A fan-out source starts with `ref: <id>`; a wrapped source's own text starts after the
    // boundary's `---` line (the security notice and metadata come before it).
    const start = text.findIndex((l) => BOUNDARY_RE.test(l));
    const sep = start >= 0 ? text.indexOf("---", start) : -1;
    const first =
      text.find((l) => l.startsWith("ref: ")) ??
      text.slice(sep + 1).find((l) => l && !BOUNDARY_RE.test(l)) ??
      "";
    lines.push(`${id} (${src.tool}): ${first.slice(0, 160)}`);
  }
  return lines.length ? { autopilotEvidence: lines.join("\n").slice(0, 2000) } : {};
}

/**
 * Keep the `N. id: …` entries of a mail list whose id is in `ids`. The text before the first
 * entry (notice, opening boundary) and the closing untrusted-content boundary always stay.
 */
export function keepListEntries(text: string, ids: ReadonlySet<string>): string {
  const END = /\n?<<<\s*END_EXTERNAL_UNTRUSTED_CONTENT\s*>>>\s*$/;
  const tail = END.exec(text)?.[0] ?? "";
  const body = tail ? text.slice(0, text.length - tail.length) : text;
  const parts = body.split(/\n(?=\s*\d+\. id: )/);
  const head = /^\s*\d+\. id: /.test(parts[0] ?? "") ? [] : [parts.shift() ?? ""];
  const kept = parts.filter((p) => {
    const id = /^\s*\d+\. id: (\S+)/.exec(p)?.[1];
    return id !== undefined && ids.has(id);
  });
  return [...head, ...kept].join("\n") + tail;
}
