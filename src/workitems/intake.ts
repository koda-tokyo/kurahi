// Email intake: a Business agent turns a message it read through a mail connector (Microsoft 365,
// Gmail) into a work item. The item keeps a REFERENCE to the message (connector, message id and a
// few bounded header values), never its body: the body stays in the mailbox and is read again
// through the connector when someone needs it. The summary is the agent's own words.
//
// Intake is idempotent on (connector, messageId) within a Project: taking the same message in
// again returns the item made the first time. New items always start in `new`; nothing here can
// approve, and flags the agent raises can only be cleared by a person (clear-flag.ts).

import fs from "node:fs";
import type { Project } from "../projects/types.js";
import type { Actor, WorkItem, WorkItemFlag, WorkItemOrigin } from "./types.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { detectSuspiciousPatterns } from "../security/external-content.js";
import { canRead } from "./access.js";
import { WorkItemRefused } from "./errors.js";
import { cleanFlagReason, cleanFlags } from "./flags.js";
import { createWorkItem, type CreateInput, type LifecycleOpts } from "./lifecycle.js";
import { loadWorkQueuePolicy } from "./policy.js";
import { readAllWorkItems, withItemLock, workItemsRoot } from "./store.js";
import { EMAIL_CONNECTORS } from "./types.js";

/** Union of the Graph and Gmail message id alphabets (both connectors validate theirs again). */
const MESSAGE_ID_RE = /^[A-Za-z0-9!._=+,:/-]{1,512}$/;
/** Address only: `local@domain.tld`, no display name, no angle brackets. */
const ADDRESS_RE =
  /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
export const SUBJECT_MAX = 300;
export const SUMMARY_MAX = 2000;
const ADDRESS_MAX = 254;
/** The connector's untrusted-content boundary: seeing it in stored text means body was copied. */
const UNTRUSTED_MARKER_RE = /<<<\s*(?:END_)?EXTERNAL_UNTRUSTED_CONTENT\s*>>>/i;

// oxlint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]+/g;

function oneLine(v: string): string {
  return v.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
}

function refuseCopiedContent(v: string, what: string): void {
  if (UNTRUSTED_MARKER_RE.test(v)) {
    throw new Error(
      `${what} contains the untrusted-content boundary; store your own words, never the message text`,
    );
  }
}

/** Validate an email reference strictly. Throws with the offending field named. */
export function cleanEmailOrigin(raw: unknown): WorkItemOrigin {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("source must be an object");
  }
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!["kind", "connector", "messageId", "receivedAt", "from", "subject"].includes(k)) {
      throw new Error(`source: unknown field ${k} (the message body is never stored)`);
    }
  }
  if (r.kind !== "email") {
    throw new Error("source.kind must be email");
  }
  if (
    typeof r.connector !== "string" ||
    !(EMAIL_CONNECTORS as readonly string[]).includes(r.connector)
  ) {
    throw new Error(`source.connector must be one of ${EMAIL_CONNECTORS.join(", ")}`);
  }
  if (
    typeof r.messageId !== "string" ||
    !MESSAGE_ID_RE.test(r.messageId) ||
    r.messageId.includes("..")
  ) {
    throw new Error("source.messageId must be the connector's message id (1-512 id characters)");
  }
  const out: WorkItemOrigin = {
    kind: "email",
    connector: r.connector as WorkItemOrigin["connector"],
    messageId: r.messageId,
  };
  if (r.receivedAt !== undefined) {
    if (
      typeof r.receivedAt !== "string" ||
      !ISO_RE.test(r.receivedAt) ||
      Number.isNaN(Date.parse(r.receivedAt))
    ) {
      throw new Error("source.receivedAt must be an ISO 8601 date-time with a time zone");
    }
    out.receivedAt = new Date(r.receivedAt).toISOString();
  }
  if (r.from !== undefined) {
    const from = typeof r.from === "string" ? r.from.trim() : "";
    if (from.length > ADDRESS_MAX || !ADDRESS_RE.test(from)) {
      throw new Error("source.from must be a bare email address (no display name)");
    }
    out.from = from;
  }
  if (r.subject !== undefined) {
    if (typeof r.subject !== "string") {
      throw new Error("source.subject must be a string");
    }
    const subject = oneLine(r.subject);
    if (subject.length > SUBJECT_MAX) {
      throw new Error(`source.subject is longer than ${SUBJECT_MAX} characters`);
    }
    refuseCopiedContent(subject, "source.subject");
    if (subject) {
      out.subject = subject;
    }
  }
  return out;
}

export function cleanSummary(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("summary is required (a short description in your own words)");
  }
  // Newlines stay (a summary may have lines); other control characters become spaces.
  const v = raw
    .replace(/\r\n?/g, "\n")
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ")
    .trim();
  if (v.length > SUMMARY_MAX) {
    throw new Error(`summary is longer than ${SUMMARY_MAX} characters; summarise, do not copy`);
  }
  refuseCopiedContent(v, "summary");
  return v;
}

export type IntakeEmailInput = {
  queue?: unknown;
  title?: unknown;
  type?: unknown;
  priority?: unknown;
  dueAt?: unknown;
  summary?: unknown;
  source?: unknown;
  flags?: unknown;
  flagReason?: unknown;
};

export type IntakeResult = { item: WorkItem; created: boolean };

/**
 * In-process callers only (the autopilot engine), never the gateway method or an agent tool:
 * attribution fields kept on a NEW item's source.fields (routine, run …). Ignored when the
 * message was taken in before.
 */
export type IntakeExtras = { fields?: Record<string, string | number | boolean | null> };

/** The item already made from this message in the Project, if any. */
export function findByEmailOrigin(
  projectId: string,
  origin: Pick<WorkItemOrigin, "connector" | "messageId">,
  home?: string,
): WorkItem | null {
  return (
    readAllWorkItems(projectId, { home }).find(
      (it) =>
        it.source.origin?.kind === "email" &&
        it.source.origin.connector === origin.connector &&
        it.source.origin.messageId === origin.messageId,
    ) ?? null
  );
}

export function intakeEmail(
  project: Project,
  input: IntakeEmailInput,
  actor: Actor,
  opts: LifecycleOpts = {},
  extras: IntakeExtras = {},
): IntakeResult {
  if (project.archived) {
    throw new Error("project is archived");
  }
  const home = opts.home ?? resolveKoloHome();
  const origin = cleanEmailOrigin(input.source);
  const summary = cleanSummary(input.summary);
  const flags: WorkItemFlag[] = cleanFlags(input.flags);
  let flagReason = cleanFlagReason(input.flagReason);
  // The subject is sender-controlled: flag injection-shaped subjects even if the agent did not.
  if (
    origin.subject &&
    detectSuspiciousPatterns(origin.subject).length > 0 &&
    !flags.includes("prompt_injection")
  ) {
    flags.push("prompt_injection");
    flagReason = [flagReason, "subject matches prompt-injection patterns"]
      .filter(Boolean)
      .join("; ")
      .slice(0, 500);
  }
  if (typeof input.title === "string") {
    refuseCopiedContent(input.title, "title");
  }
  const root = workItemsRoot(project.id, home);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // One intake at a time per Project (across processes): the duplicate check and the insert are
  // one step, so two agents reading the same message never make two items.
  return withItemLock(root, () => {
    const existing = findByEmailOrigin(project.id, origin, home);
    if (existing) {
      return { item: existing, created: false };
    }
    const create: CreateInput = {
      queue: input.queue,
      type: input.type,
      title: input.title,
      priority: input.priority,
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(extras.fields ? { source: { fields: extras.fields } } : {}),
    };
    const item = createWorkItem(
      project,
      create,
      actor,
      { ...opts, home },
      {
        origin,
        summary,
        flags: flags.length ? cleanFlags(flags) : undefined,
        flagReason: flags.length ? flagReason : undefined,
      },
    );
    return { item, created: true };
  });
}

/**
 * Intake as a caller sees it (workitems.intakeEmail, and the agent tool when it runs inside the
 * gateway): a message taken in before by someone the caller may not read is refused without
 * showing that item.
 */
export function intakeEmailForCaller(
  project: Project,
  input: IntakeEmailInput,
  actor: Actor,
  opts: LifecycleOpts = {},
): IntakeResult {
  const out = intakeEmail(project, input, actor, opts);
  if (
    !out.created &&
    !canRead(out.item, actor, loadWorkQueuePolicy(project, opts.home), opts.now ?? new Date())
  ) {
    throw new WorkItemRefused(
      "duplicate_source",
      "this message was already taken in as a work item you are not authorised to read",
    );
  }
  return out;
}
