// Executing one allowed action of one plan item (runner.ts decides; this only carries out).
//
// Within one item, actions form a declared sequence the engine binds itself:
//   mail.draft     → the draft's id is kept for the item (a reply to the item's own message when
//                    the item is an email and the model named no other message);
//   office.create  → the office plugin renders the typed spec (office-spec.ts) into
//                    output/autopilot/<run>/<n>/<file> (or the routine's outputFolder:
//                    <folder>/<day>/<run>-<n>-<file>) through its own tool;
//   mail.attach    → attaches THAT document to THAT draft. The model names neither, so it can
//                    never attach another file or touch another draft.
// L3 sends run under the engine invocation context carrying the standing approval the
// authorize step chose; the connector verifies it again and reports whether it used it.

import type { Project } from "../projects/types.js";
import type { ActionDef } from "./actions.js";
import type { EngineCallInfo } from "./engine-origin.js";
import type { RunnerDeps } from "./runner.js";
import type { PlanItem, Routine } from "./types.js";
import type { EmailOriginRef } from "./workitems-adapter.js";
import { loadWorkQueuePolicy } from "../workitems/policy.js";
import { buildBrief, memberActor, renderBriefText, writeBriefFile } from "./brief.js";
import {
  hasOfficeSpecParser,
  isOfficeKind,
  OFFICE_PLUGIN_ID,
  OFFICE_TOOL_OF,
  officeSpecError,
} from "./office-spec.js";

export type ItemContext = {
  /** 1-based position of the item in the run (output folder of its documents). */
  index: number;
  origin: EmailOriginRef | undefined;
  draftId: string | null;
  documentPath: string | null;
  /** Project-relative files this item's actions wrote (the work item references them). */
  documents: string[];
};

/** A Project-relative path a tool reported (no absolute path, no `..`). */
function relFile(v: unknown): string | null {
  if (typeof v !== "string" || !v || v.length > 512) {
    return null;
  }
  const p = v.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").some((s) => s === ".." || !s)) {
    return null;
  }
  return p;
}

export type ActCall = {
  deps: RunnerDeps;
  project: Project;
  routine: Routine;
  runId: string;
  sessionKey: string;
  agentId: string;
  engine: EngineCallInfo;
  workItems: string[];
};

export type ActResult = {
  /** What the action produced (draft id, file path, work item id …). */
  ref: string | null;
  approvalUsed: string | null;
  fallback: string | null;
};

const DRAFT_ID_RE = /\bdraft (\S+?)[ ,;]/;

async function tool(
  call: ActCall,
  name: string,
  args: Record<string, unknown>,
  engine: EngineCallInfo = call.engine,
) {
  const res = await call.deps.tools({
    sessionKey: call.sessionKey,
    agentId: call.agentId,
    tool: name,
    args,
    source: `autopilot:${call.routine.id}`,
    engine,
  });
  if (!res.ok) {
    throw new Error(res.error);
  }
  return res;
}

export async function executeAction(
  call: ActCall,
  def: ActionDef,
  args: Record<string, unknown>,
  item: PlanItem,
  ctx: ItemContext,
): Promise<ActResult> {
  const done = (ref: string | null): ActResult => ({ ref, approvalUsed: null, fallback: null });
  switch (def.executor) {
    case "tool": {
      if (def.id === "mail.attach") {
        if (!ctx.draftId || !ctx.documentPath) {
          throw new Error(
            "mail.attach needs this item's mail.draft and office.create to succeed first",
          );
        }
        const name = call.routine.actionTools[def.id] ?? def.tools[0];
        await tool(call, name, { draftId: ctx.draftId, path: ctx.documentPath });
        return done(`${name}:${ctx.draftId.slice(0, 120)}`);
      }
      const name = call.routine.actionTools[def.id] ?? def.tools[0];
      if (!name || !def.tools.includes(name)) {
        throw new Error(`no tool for ${def.id}`);
      }
      let toolArgs = args;
      let engine = call.engine;
      if (def.id === "mail.draft" && ctx.origin && toolArgs.replyToMessageId === undefined) {
        toolArgs = { ...toolArgs, replyToMessageId: ctx.origin.messageId };
      }
      if (def.class === "external") {
        // The template is engine context (checked against the approval), not a tool argument.
        const { templateId, ...rest } = toolArgs;
        toolArgs = rest;
        engine = { ...engine, templateId: typeof templateId === "string" ? templateId : null };
      }
      const res = await tool(call, name, toolArgs, engine);
      const detailId = typeof res.details?.id === "string" ? res.details.id : null;
      const id = detailId ?? /\bid:\s*(\S+)/.exec(res.text)?.[1] ?? DRAFT_ID_RE.exec(res.text)?.[1];
      if (def.id === "mail.draft") {
        ctx.draftId = id ?? null;
      }
      const file = def.producesFile ? relFile(res.details?.path) : null;
      if (file) {
        ctx.documents.push(file);
        return {
          ref: `${name}:${file.slice(0, 200)}`,
          approvalUsed: res.approvalUsed ?? null,
          fallback: res.approvalFallback?.code ?? null,
        };
      }
      return {
        ref: id ? `${name}:${id.slice(0, 200)}` : name,
        approvalUsed: res.approvalUsed ?? null,
        fallback: res.approvalFallback?.code ?? null,
      };
    }
    case "office": {
      const kind = args.kind;
      if (!isOfficeKind(kind)) {
        throw new Error("office.create: unknown kind");
      }
      // The plugin's own parser validates the spec before anything is written (fail closed).
      if (!hasOfficeSpecParser(kind)) {
        call.deps.ensureTools?.(call.sessionKey);
      }
      const invalid = officeSpecError(args);
      if (invalid) {
        throw new Error(`office.create: ${invalid}`);
      }
      // A routine may name its own output folder (e.g. output/literature): the documents land in
      // a dated folder people find, prefixed with the run and item so nothing is ever replaced.
      const out = call.routine.outputFolder;
      const day = (call.deps.now?.() ?? new Date()).toLocaleDateString("sv-SE", {
        timeZone: call.engine.tz,
      });
      const rel = out
        ? `${out}/${day}/${call.runId}-${ctx.index}-${String(args.file)}`
        : `output/autopilot/${call.runId}/${ctx.index}/${String(args.file)}`;
      const name = OFFICE_TOOL_OF[kind];
      const res = await tool(call, name, {
        ...(args.spec as Record<string, unknown>),
        path: rel,
        overwrite: false,
      });
      if (res.pluginId !== OFFICE_PLUGIN_ID) {
        throw new Error(
          `${name} is provided by ${res.pluginId ?? "core"}, not ${OFFICE_PLUGIN_ID}`,
        );
      }
      const written = typeof res.details?.path === "string" ? res.details.path : null;
      if (written !== rel) {
        throw new Error(`office.create: the document was not written to ${rel}`);
      }
      ctx.documentPath = rel;
      ctx.documents.push(rel);
      return done(rel);
    }
    case "brief": {
      // The recipient is the member's own address from the work queue policy, never the plan.
      const principal = String(args.principal);
      const home = call.deps.home;
      const policy = loadWorkQueuePolicy(call.project, home);
      const member = policy.access.members.find((m) => m.principal === principal);
      if (!member) {
        throw new Error("brief.deliver: the principal is not a member of this Project");
      }
      const now = call.deps.now?.() ?? new Date();
      const { actor, mayAcceptProposals } = memberActor(policy, call.project.id, principal);
      const brief = buildBrief(call.project, actor, { now, home, mayAcceptProposals });
      const text = renderBriefText(brief, call.engine.tz);
      if (member.email) {
        // Drafts only: the one tool this action has creates a draft; a person sends it, or not.
        const name = def.tools[0];
        const res = await tool(call, name, {
          to: [member.email],
          subject: text.subject,
          body: text.body.slice(0, 30_000),
        });
        const id = typeof res.details?.id === "string" ? res.details.id : null;
        return done(id ? `${name}:${id.slice(0, 200)}` : name);
      }
      const day = now.toLocaleDateString("sv-SE", { timeZone: call.engine.tz });
      return done(writeBriefFile(call.project, principal, text, day));
    }
    case "proposal": {
      const created = call.deps.workItems.create({
        project: call.project,
        routine: call.routine,
        runId: call.runId,
        item,
        kind: "proposal",
        title: typeof args.title === "string" ? args.title : undefined,
        note: typeof args.note === "string" ? args.note : undefined,
        awaitingPerson: "meeting time proposal: a person confirms and books",
        pending: [],
        fields: {
          proposedSlots: (args.slots as string[]).join("\n").slice(0, 2000),
          ...(Array.isArray(args.attendees)
            ? { attendees: (args.attendees as string[]).join(", ").slice(0, 2000) }
            : {}),
        },
      });
      call.workItems.push(created.id);
      return done(created.id);
    }
    default:
      throw new Error(`${def.id} has no executor`);
  }
}
