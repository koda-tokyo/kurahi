// Agent drafting: workitems.assignAgent starts one agent run in the item's project session
// (`agent:<agent>:proj-<project>-wi<item>`), so the project's folder scope, mode and tool guard
// apply exactly as in a project chat. The run's final reply becomes a new artifact (成果物,
// status 確認中 / review) pinned as the item's draft; the policy checks then run automatically
// and the item moves to awaiting_review. The agent never decides: it only produces the draft.

import { randomUUID } from "node:crypto";
import type { Project } from "../projects/types.js";
import type { Actor, WorkItem, WorkItemStatus } from "./types.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import {
  addArtifactVersion,
  getArtifact,
  saveArtifact,
  setArtifactStatus,
  type Artifact,
} from "../projects/artifacts.js";
import { projectSessionKey } from "../projects/scope.js";
import { isAgentAllowed } from "../projects/store.js";
import {
  applyTransition,
  checkSummary,
  recheck,
  restartRoute,
  type LifecycleOpts,
} from "./lifecycle.js";
import { loadWorkQueuePolicy, ruleApplies, type WorkQueuePolicy } from "./policy.js";
import { readWorkItem } from "./store.js";

export const DEFAULT_AGENT_ID = "main";
/** A drafting run older than this may be re-assigned (e.g. the gateway restarted mid-run). */
export const STALE_DRAFTING_MS = 30 * 60_000;
const MAX_DRAFT_CHARS = 200_000;

export type DraftRunRequest = {
  agentId: string;
  sessionKey: string;
  runId: string;
  message: string;
  extraSystemPrompt: string;
};

/** Runs one agent turn and returns its final reply text. The gateway passes agentCommand. */
export type DraftRunner = (req: DraftRunRequest) => Promise<{ text: string }>;

function line(label: string, value: unknown): string {
  return `- ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
}

export function buildDraftPrompt(
  item: WorkItem,
  policy: WorkQueuePolicy,
  instructions: string | null,
): { message: string; extraSystemPrompt: string } {
  const queue = policy.queues.find((q) => q.id === item.queue);
  const rules = policy.rules
    .filter((r) => ruleApplies(r, item))
    .map(
      (r) =>
        `- [${r.id}] ${r.label.en ?? r.label.ja ?? r.id}${r.label.ja && r.label.en ? ` / ${r.label.ja}` : ""}`,
    );
  const sentBack = item.history
    .filter((h) => h.action === "decide.send_back" && h.comment)
    .map((h) => `- ${h.at}: ${h.comment}`);
  const parts = [
    `Work item ${item.id} (${item.type}) in queue ${queue?.name.en ?? item.queue}${queue?.name.ja ? ` / ${queue.name.ja}` : ""}.`,
    `Title: ${item.title}`,
    "",
    "Form fields:",
    ...(Object.keys(item.source.fields).length
      ? Object.entries(item.source.fields).map(([k, v]) => line(k, v))
      : ["- (none)"]),
    "",
    "Source documents (read them with your file tools; they are inside this project):",
    ...(item.source.documents.length
      ? item.source.documents.map((d) => `- ${d.name} (${d.kind}: ${d.ref})`)
      : ["- (none)"]),
    "",
    "Policy rules the draft will be checked against:",
    ...(rules.length ? rules : ["- (none)"]),
    ...(sentBack.length
      ? ["", "The reviewer sent earlier drafts back with these comments:", ...sentBack]
      : []),
    ...(instructions ? ["", "Instructions from the person who assigned this:", instructions] : []),
    "",
    "Reply with the draft only (Markdown). It is saved for review as it is.",
  ];
  const extraSystemPrompt = [
    "You are drafting a back-office work item for a person to review.",
    "Never send, submit, pay, book or share anything, and never claim that anything was approved.",
    "Use only the facts in the form fields and source documents; mark anything missing as 【要確認 / to confirm】.",
    "Your reply is saved as the draft; a person approves or sends it back.",
  ].join("\n");
  return { message: parts.join("\n"), extraSystemPrompt };
}

function lastAssignFrom(item: WorkItem): WorkItemStatus {
  const h = item.history.findLast((e) => e.action === "assign_agent");
  return h?.from === "sent_back" ? "sent_back" : "new";
}

/** Move the item to drafting under an agent. Returns the item and the run request to start. */
export function startDrafting(
  project: Project,
  id: string,
  input: { agentId?: unknown; instructions?: unknown },
  actor: Actor,
  expectedRevision: number | undefined,
  opts: LifecycleOpts = {},
): { item: WorkItem; request: DraftRunRequest } {
  if (project.archived) {
    throw new Error("project is archived");
  }
  const home = opts.home ?? resolveKoloHome();
  const policy = loadWorkQueuePolicy(project, home);
  const current = readWorkItem(project.id, id, home);
  if (!current) {
    throw new Error("work item not found");
  }
  const agentId =
    typeof input.agentId === "string" && input.agentId.trim()
      ? input.agentId.trim()
      : (policy.queues.find((q) => q.id === current.queue)?.defaultAgent ?? DEFAULT_AGENT_ID);
  if (!isAgentAllowed(project, agentId, DEFAULT_AGENT_ID)) {
    throw new Error(`agent ${agentId} is not allowed in this project`);
  }
  const instructions =
    typeof input.instructions === "string" && input.instructions.trim()
      ? input.instructions.trim().slice(0, 4000)
      : null;
  const runId = randomUUID();
  const holder: { request: DraftRunRequest | null } = { request: null };
  const item = applyTransition(
    project,
    id,
    expectedRevision,
    (cur, now) => {
      const stale =
        cur.status === "drafting" && now.getTime() - Date.parse(cur.updatedAt) > STALE_DRAFTING_MS;
      if (!["new", "sent_back"].includes(cur.status) && !stale) {
        throw new Error(`an agent can draft only a new or sent-back item (it is ${cur.status})`);
      }
      cur.assignee = { kind: "agent", id: agentId };
      cur.runIds.push(runId);
      cur.lastError = null;
      const prompt = buildDraftPrompt(cur, policy, instructions);
      holder.request = {
        agentId,
        runId,
        sessionKey: projectSessionKey(agentId, project.id, `wi${cur.id.slice(1)}`),
        ...prompt,
      };
      return {
        next: cur,
        spec: {
          action: "assign_agent",
          actor,
          to: "drafting",
          detail: { agentId, runId, retry: stale, instructions: instructions !== null },
        },
      };
    },
    opts,
  );
  if (!holder.request) {
    throw new Error("drafting did not start");
  }
  return { item, request: holder.request };
}

/** The run finished with a reply: save it as the draft artifact and run the checks. */
export function completeDraft(
  project: Project,
  id: string,
  run: { runId: string; agentId: string; text: string; sessionKey: string },
  opts: LifecycleOpts = {},
): WorkItem {
  const home = opts.home ?? resolveKoloHome();
  const agent: Actor = { id: `agent:${run.agentId}`, kind: "agent" };
  const text = run.text.trim().slice(0, MAX_DRAFT_CHARS);
  if (!text) {
    return failDraft(project, id, run.runId, "the agent returned an empty draft", opts);
  }
  return applyTransition(
    project,
    id,
    undefined,
    (cur, now) => {
      if (cur.status !== "drafting" || cur.runIds.at(-1) !== run.runId) {
        throw new Error("this run is no longer the item's current drafting run");
      }
      const artifact = saveDraftArtifact(project, cur, run, text, agent, home, now);
      const v = artifact.versions.at(-1)!;
      cur.draft = {
        artifactId: artifact.id,
        version: v.version,
        sha256: v.sha256,
        agentId: run.agentId,
        runId: run.runId,
        createdAt: now.toISOString(),
      };
      cur.approvals = [];
      cur.override = null;
      recheck(project, cur, now, home);
      restartRoute(project, cur, now, home, true);
      return {
        next: cur,
        spec: {
          action: "draft",
          actor: agent,
          to: "awaiting_review",
          detail: {
            runId: run.runId,
            artifactId: artifact.id,
            version: v.version,
            sha256: v.sha256,
            checks: checkSummary(cur),
          },
        },
      };
    },
    opts,
  );
}

/**
 * A re-draft (after send back) becomes the next version of the item's draft artifact, so the
 * reviewer can diff the rounds (workitems.draftDiff). A first draft, or a pinned artifact from
 * elsewhere, starts a new artifact.
 */
function saveDraftArtifact(
  project: Project,
  cur: WorkItem,
  run: { agentId: string; sessionKey: string },
  text: string,
  agent: Actor,
  home: string,
  now: Date,
): Artifact {
  if (cur.draft) {
    try {
      const prev = getArtifact(cur.draft.artifactId, null, { home }).artifact;
      if (prev.projectId === project.id && prev.type === "draft") {
        let next: Artifact;
        try {
          next = addArtifactVersion(
            {
              id: prev.id,
              content: text,
              agentId: run.agentId,
              sourceSession: run.sessionKey,
              note: `work item ${cur.id}`,
            },
            agent.id,
            { home, now },
          );
        } catch (err) {
          if (!/identical/.test(String(err))) {
            throw err;
          }
          next = prev;
        }
        if (next.status === "draft") {
          setArtifactStatus({ id: next.id, status: "review" }, agent.id, { home, now });
        }
        return getArtifact(next.id, null, { home }).artifact;
      }
    } catch {
      // Unreadable earlier draft: start a new artifact below.
    }
  }
  const artifact = saveArtifact(
    {
      title: `${cur.title} — draft`.slice(0, 200),
      type: "draft",
      format: "md",
      content: text,
      projectId: project.id,
      agentId: run.agentId,
      sourceSession: run.sessionKey,
      note: `work item ${cur.id}`,
    },
    agent.id,
    { home, now },
  );
  setArtifactStatus({ id: artifact.id, status: "review" }, agent.id, { home, now });
  return artifact;
}

/** The run failed: back to where drafting started, with the error kept on the item. */
export function failDraft(
  project: Project,
  id: string,
  runId: string,
  error: string,
  opts: LifecycleOpts = {},
): WorkItem {
  return applyTransition(
    project,
    id,
    undefined,
    (cur) => {
      if (cur.status !== "drafting" || cur.runIds.at(-1) !== runId) {
        throw new Error("this run is no longer the item's current drafting run");
      }
      cur.lastError = error.slice(0, 1000);
      return {
        next: cur,
        spec: {
          action: "draft_failed",
          actor: { id: "system", kind: "system" },
          to: lastAssignFrom(cur),
          detail: { runId, error: cur.lastError },
        },
      };
    },
    opts,
  );
}

/**
 * assignAgent: move to drafting, start the run, and settle the item when it ends. Returns at
 * once; `done` resolves with the settled item (tests and callers that want to wait use it).
 */
export function assignAgent(
  project: Project,
  id: string,
  input: { agentId?: unknown; instructions?: unknown },
  actor: Actor,
  expectedRevision: number | undefined,
  runner: DraftRunner,
  opts: LifecycleOpts & { onChange?: (item: WorkItem) => void } = {},
): { item: WorkItem; runId: string; done: Promise<WorkItem | null> } {
  const { item, request } = startDrafting(project, id, input, actor, expectedRevision, opts);
  const settle = (fn: () => WorkItem): WorkItem | null => {
    try {
      const next = fn();
      opts.onChange?.(next);
      return next;
    } catch {
      // The item moved on (cancelled or re-assigned) while the run was going: nothing to do.
      return null;
    }
  };
  const lifecycle = { home: opts.home, env: opts.env };
  const done = Promise.resolve()
    .then(() => runner(request))
    .then(
      (res) =>
        settle(() =>
          completeDraft(
            project,
            id,
            {
              runId: request.runId,
              agentId: request.agentId,
              text: res.text,
              sessionKey: request.sessionKey,
            },
            lifecycle,
          ),
        ),
      (err: unknown) =>
        settle(() =>
          failDraft(
            project,
            id,
            request.runId,
            err instanceof Error ? err.message : String(err),
            lifecycle,
          ),
        ),
    );
  return { item, runId: request.runId, done };
}
