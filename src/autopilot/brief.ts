// The morning brief (docs/autopilot.md#morning-brief): per person, what the autopilot handled in
// a time window (default the last 24 h), the documents it prepared, what waits for that person
// (decisions, flagged items they may clear, earned-autonomy proposals they may accept, linked
// cases they own that need a step opened or are blocked), commitments coming due and the routines' problems (watchdog trips, failed or skipped runs,
// demotions, pauses, an invalid routines file).
//
// Built only from recorded data (run summaries and records, routine state, the work queue), with
// no model call. Work items appear only when the person can already read them (the work queue's
// own canRead / awaitsPrincipal / clear-flag rules); routine-level facts are what any observer
// already sees in autopilot.routines.list and autopilot.stats.
//
// Delivery (the `brief.deliver` action, class prepare) renders it as Japanese and English text
// and either drafts it in Outlook, addressed to the person's own work address from the work
// queue policy (`access.members[].email`), or writes it to the Project's output/briefs/. It never
// sends anything and never uses LINE or WhatsApp.

import fs from "node:fs";
import path from "node:path";
import type { Project } from "../projects/types.js";
import type { WorkQueuePolicy } from "../workitems/policy.js";
import type { Actor, WorkItem } from "../workitems/types.js";
import type { AutonomyProposalView } from "./earned-autonomy.js";
import type { AutonomyLevel, Edition, PlanItem, Routine } from "./types.js";
import { writableForMode } from "../projects/scope.js";
import {
  awaitsPrincipal,
  canRead,
  currentStage,
  isPrivileged,
  rolesOf,
} from "../workitems/access.js";
import { mayClearFlags } from "../workitems/clear-flag.js";
import { linkedCaseStatus } from "../workitems/links-store.js";
import { listNotifications } from "../workitems/notifications-store.js";
import { loadWorkQueuePolicy } from "../workitems/policy.js";
import { readAllWorkItems } from "../workitems/store.js";
import { TERMINAL_STATUSES } from "../workitems/types.js";
import { readGlobalControl } from "./control.js";
import { autonomyProposals } from "./earned-autonomy.js";
import { loadRoutines } from "./routines.js";
import { readRun, readRunSummaries, routineState } from "./store.js";
import { departmentOf } from "./types.js";

/** The built-in "prompt" of a brief routine: the engine builds the plan, no model is called. */
export const BRIEF_PROMPT_ID = "morning-brief";
export const BRIEF_ACTION = "brief.deliver";
export const BRIEF_DIR = "output/briefs";
const DAY_MS = 86_400_000;
const LIST_MAX = 50;
const RUN_RECORDS_MAX = 500;

export type BriefItem = {
  projectId: string;
  /** Deep link: the work item id (open it with workitems.get). */
  itemId: string;
  title: string;
  queue: string;
  status: WorkItem["status"];
  priority: WorkItem["priority"];
  dueAt: string | null;
  overdue: boolean;
};

export type BriefArea = {
  edition: Edition;
  area: string;
  department: string | null;
  runs: number;
  items: number;
  prepared: number;
  acted: number;
  escalated: number;
  handled: number;
};

/**
 * A linked case the person owns (requested, assigned or must decide the parent) that needs a
 * person: steps ready to open, a blocked or missing step, or a record that cannot be read.
 */
export type BriefLinkedCase = BriefItem & {
  done: number;
  total: number;
  /** Step keys whose dependencies are done and that have no child item yet. */
  ready: string[];
  /** Step keys whose child item no longer exists. */
  missing: string[];
  blocked: boolean;
  /** The linked case record could not be read; progress fields are zero/empty. */
  unreadable: boolean;
};

export type MorningBrief = {
  version: 1;
  projectId: string;
  projectName: string;
  principal: string;
  name: string | null;
  window: { from: string; to: string };
  generatedAt: string;
  handled: {
    runs: number;
    failedRuns: number;
    items: number;
    prepared: number;
    acted: number;
    escalated: number;
    handled: number;
    /** Reply drafts the routines prepared (mail.draft executed). */
    drafts: number;
    areas: BriefArea[];
  };
  /** Documents the routines wrote (office.create), Project-relative paths. */
  documents: Array<{ runId: string; routineId: string; path: string; at: string }>;
  waiting: {
    /** Items whose current stage this person may decide now. */
    decisions: BriefItem[];
    /** Flagged items this person may clear (workitems.clearFlag). */
    flagged: Array<BriefItem & { flags: string[] }>;
    /** Earned-autonomy proposals this person may accept or decline (not declined yet). */
    proposals: Array<{
      routineId: string;
      kind: "promote" | "demote";
      current: AutonomyLevel;
      proposed: AutonomyLevel;
      reason: AutonomyProposalView["reason"];
      needsStandingApproval: boolean;
      acceptBlocker: AutonomyProposalView["acceptBlocker"];
    }>;
    /** Linked cases needing a person (optional: briefs delivered before it existed lack it). */
    linked?: BriefLinkedCase[];
    /**
     * The person's unread in-app notifications on items they can still read; `unreadable` when
     * their notification file refuses to read (optional: older briefs lack it).
     */
    notifications?: { unread: number; unreadable: boolean };
  };
  /** Open items this person requested or must decide, due by the end of the next day. */
  commitments: BriefItem[];
  /** A list was cut at its cap: more exist than the brief shows. */
  truncated: {
    documents: boolean;
    decisions: boolean;
    flagged: boolean;
    commitments: boolean;
    linked?: boolean;
  };
  problems: {
    watchdog: Array<{ routineId: string; runId: string; at: string; reasons: string[] }>;
    runs: Array<{
      routineId: string;
      runId: string;
      at: string;
      status: "failed" | "skipped";
      reason: string | null;
    }>;
    demotions: Array<{
      routineId: string;
      at: string;
      from: AutonomyLevel;
      to: AutonomyLevel;
      cause: string;
    }>;
    paused: Array<{
      routineId: string;
      pausedBy: string | null;
      pausedAt: string | null;
      reason: string | null;
    }>;
    /** The routines file is invalid: no routine of the Project runs. */
    routinesError: string | null;
    control: { stopped: boolean; emergencyStop: boolean };
  };
};

export type BriefOptions = {
  from?: Date;
  to?: Date;
  now?: Date;
  home?: string;
  /** The person may accept autonomy proposals (operator.approvals, or an approver role). */
  mayAcceptProposals?: boolean;
};

function dueOf(item: WorkItem): string | null {
  const stage = currentStage(item);
  const times = [item.dueAt, stage?.dueAt ?? null].filter((t): t is string => Boolean(t));
  return times.length ? times.toSorted()[0] : null;
}

function briefItem(item: WorkItem, now: Date): BriefItem {
  const dueAt = dueOf(item);
  return {
    projectId: item.projectId,
    itemId: item.id,
    title: item.title,
    queue: item.queue,
    status: item.status,
    priority: item.priority,
    dueAt,
    overdue: dueAt !== null && Date.parse(dueAt) < now.getTime(),
  };
}

const byDue = (a: BriefItem, b: BriefItem) =>
  (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") || a.itemId.localeCompare(b.itemId);

/** Build one person's brief for the window [from, to] (default: the 24 h before now). */
export function buildBrief(
  project: Pick<Project, "id" | "name" | "folder" | "templateId">,
  actor: Actor,
  opts: BriefOptions = {},
): MorningBrief {
  const now = opts.now ?? new Date();
  const to = opts.to ?? now;
  const from = opts.from ?? new Date(to.getTime() - DAY_MS);
  const home = opts.home;
  const policy = loadWorkQueuePolicy(project, home);
  const member = policy.access.members.find((m) => m.principal === actor.id) ?? null;
  const set = loadRoutines(project, home);
  const inWindow = (t: string) => {
    const at = Date.parse(t);
    return at >= from.getTime() && at <= to.getTime();
  };

  // ---- what the routines handled (run summaries in the window) ----
  const runs = readRunSummaries(project.id, home).filter((r) => inWindow(r.startedAt));
  const areas = new Map<string, BriefArea>();
  const handled: MorningBrief["handled"] = {
    runs: 0,
    failedRuns: 0,
    items: 0,
    prepared: 0,
    acted: 0,
    escalated: 0,
    handled: 0,
    drafts: 0,
    areas: [],
  };
  const problems: MorningBrief["problems"] = {
    watchdog: [],
    runs: [],
    demotions: [],
    paused: [],
    routinesError: set.error,
    control: (() => {
      const c = readGlobalControl(home);
      return { stopped: c.stopped, emergencyStop: c.emergencyStop };
    })(),
  };
  for (const r of runs) {
    const key = `${r.edition}/${r.area}`;
    const row = areas.get(key) ?? {
      edition: r.edition,
      area: r.area,
      department: departmentOf(r),
      runs: 0,
      items: 0,
      prepared: 0,
      acted: 0,
      escalated: 0,
      handled: 0,
    };
    row.runs++;
    row.items += r.counts.items;
    row.prepared += r.counts.prepared;
    row.acted += r.counts.acted;
    row.escalated += r.counts.escalated;
    row.handled += r.counts.handled;
    areas.set(key, row);
    handled.runs++;
    handled.items += r.counts.items;
    handled.prepared += r.counts.prepared;
    handled.acted += r.counts.acted;
    handled.escalated += r.counts.escalated;
    handled.handled += r.counts.handled;
    if (r.status === "failed") {
      handled.failedRuns++;
    }
    if (r.status === "failed" || r.status === "skipped") {
      problems.runs.push({
        routineId: r.routineId,
        runId: r.id,
        at: r.startedAt,
        status: r.status,
        reason: r.reason,
      });
    }
    if (r.watchdog?.tripped) {
      problems.watchdog.push({
        routineId: r.routineId,
        runId: r.id,
        at: r.endedAt,
        reasons: r.watchdog.reasons,
      });
    }
  }
  handled.areas = [...areas.values()].toSorted((a, b) =>
    `${a.edition}/${a.area}`.localeCompare(`${b.edition}/${b.area}`),
  );

  // ---- documents and drafts (full run records of the window, newest first, bounded) ----
  const documents: MorningBrief["documents"] = [];
  let documentsTruncated = runs.length > RUN_RECORDS_MAX;
  for (const summary of runs.toReversed().slice(0, RUN_RECORDS_MAX)) {
    const record = readRun(project.id, summary.id, home);
    for (const a of record?.actions ?? []) {
      if (!a.executed) {
        continue;
      }
      if (a.kind === "mail.draft") {
        handled.drafts++;
      } else if (a.kind === "office.create" && a.ref) {
        if (documents.length === LIST_MAX) {
          documentsTruncated = true;
          continue;
        }
        documents.push({
          runId: summary.id,
          routineId: summary.routineId,
          path: a.ref,
          at: summary.endedAt,
        });
      }
    }
  }

  // ---- routine state: demotions in the window, paused routines ----
  for (const r of set.routines) {
    const s = routineState(project.id, r.id, home);
    if (s.lastDemotion && inWindow(s.lastDemotion.at)) {
      problems.demotions.push({
        routineId: r.id,
        at: s.lastDemotion.at,
        from: s.lastDemotion.from,
        to: s.lastDemotion.to,
        cause: s.lastDemotion.cause,
      });
    }
    if (s.paused) {
      problems.paused.push({
        routineId: r.id,
        pausedBy: s.pausedBy,
        pausedAt: s.pausedAt,
        reason: s.pauseReason,
      });
    }
  }

  // ---- work items this person can already read ----
  const decisions: BriefItem[] = [];
  const flagged: Array<BriefItem & { flags: string[] }> = [];
  const commitments: BriefItem[] = [];
  const linked: BriefLinkedCase[] = [];
  const horizon = to.getTime() + DAY_MS;
  const readable = new Set<string>();
  for (const item of readAllWorkItems(project.id, { home })) {
    if (!canRead(item, actor, policy, now)) {
      continue;
    }
    readable.add(item.id);
    if (TERMINAL_STATUSES.has(item.status)) {
      continue;
    }
    const awaiting = awaitsPrincipal(item, actor.id, policy, now);
    if (awaiting) {
      decisions.push(briefItem(item, now));
    }
    if (item.flags?.length && mayClearFlags(item, actor, policy, now)) {
      flagged.push({ ...briefItem(item, now), flags: [...item.flags] });
    }
    const due = dueOf(item);
    if (
      due &&
      Date.parse(due) <= horizon &&
      (awaiting || item.requestedBy === actor.id || item.assignee?.id === actor.id)
    ) {
      commitments.push(briefItem(item, now));
    }
    if (awaiting || item.requestedBy === actor.id || item.assignee?.id === actor.id) {
      const entry = linkedEntry(project.id, item, now, home);
      if (entry) {
        linked.push(entry);
      }
    }
  }

  // ---- unread in-app notifications, only on items the person can still read ----
  const notifications = { unread: 0, unreadable: false };
  try {
    notifications.unread = listNotifications(
      project.id,
      actor.id,
      { unreadOnly: true, visible: (id) => readable.has(id) },
      home,
    ).length;
  } catch {
    notifications.unreadable = true;
  }

  // ---- earned-autonomy proposals the person may decide ----
  const proposals: MorningBrief["waiting"]["proposals"] = [];
  if (opts.mayAcceptProposals && !set.error) {
    for (const p of autonomyProposals(project.id, set.routines, { now, home })) {
      if (p.kind === "hold" || p.declined) {
        continue;
      }
      proposals.push({
        routineId: p.routineId,
        kind: p.kind,
        current: p.current,
        proposed: p.proposed,
        reason: p.reason,
        needsStandingApproval: p.needsStandingApproval,
        acceptBlocker: p.acceptBlocker,
      });
    }
  }

  return {
    version: 1,
    projectId: project.id,
    projectName: project.name,
    principal: actor.id,
    name: member?.name ?? null,
    window: { from: from.toISOString(), to: to.toISOString() },
    generatedAt: now.toISOString(),
    handled,
    documents,
    waiting: {
      decisions: decisions.toSorted(byDue).slice(0, LIST_MAX),
      flagged: flagged.toSorted(byDue).slice(0, LIST_MAX),
      proposals,
      linked: linked.toSorted(byDue).slice(0, LIST_MAX),
      notifications,
    },
    commitments: commitments.toSorted(byDue).slice(0, LIST_MAX),
    truncated: {
      documents: documentsTruncated,
      decisions: decisions.length > LIST_MAX,
      flagged: flagged.length > LIST_MAX,
      commitments: commitments.length > LIST_MAX,
      linked: linked.length > LIST_MAX,
    },
    problems,
  };
}

/**
 * The parent's linked case when it needs a person, else null. A record that refuses to read is
 * reported as unreadable rather than skipped or failing the whole brief.
 */
function linkedEntry(
  projectId: string,
  item: WorkItem,
  now: Date,
  home?: string,
): BriefLinkedCase | null {
  const base = briefItem(item, now);
  let status: ReturnType<typeof linkedCaseStatus>;
  try {
    status = linkedCaseStatus(projectId, item.id, home);
  } catch {
    return {
      ...base,
      done: 0,
      total: 0,
      ready: [],
      missing: [],
      blocked: false,
      unreadable: true,
    };
  }
  if (!status || !(status.ready.length || status.missing.length || status.blocked)) {
    return null;
  }
  return {
    ...base,
    done: status.done,
    total: status.total,
    ready: status.ready,
    missing: status.missing,
    blocked: status.blocked,
    unreadable: false,
  };
}

/** Roles that let a member decide autonomy proposals in their delivered brief. */
const PROPOSAL_ROLES = new Set(["approver", "operator", "admin"]);

/** The work queue actor of a Project member (a person; privileged by role only). */
export function memberActor(
  policy: WorkQueuePolicy,
  projectId: string,
  principal: string,
): { actor: Actor; mayAcceptProposals: boolean } {
  const actor: Actor = { id: principal, kind: "person", privileged: false };
  const { roles } = rolesOf(policy, principal, projectId);
  return {
    actor: { ...actor, privileged: isPrivileged(actor, policy, projectId) },
    mayAcceptProposals: [...roles].some((r) => PROPOSAL_ROLES.has(r)),
  };
}

/**
 * The engine's plan for a brief routine: one item per Project member, each with one
 * `brief.deliver` for that member. Built from the work queue policy, never from a model.
 */
export function briefPlan(project: Pick<Project, "id" | "folder" | "templateId">, home?: string) {
  const policy = loadWorkQueuePolicy(project, home);
  return policy.access.members.map(
    (m): PlanItem => ({
      ref: `brief:${m.principal}`,
      title: `Morning brief for ${m.name ?? m.principal}`,
      summary: "Morning brief built from recorded autopilot and work queue data.",
      category: null,
      priority: "normal",
      flags: [],
      sources: [],
      actions: [{ kind: BRIEF_ACTION, args: { principal: m.principal } }],
    }),
  );
}

/** True when the routine's plan is built by the engine (no model call). */
export function isBriefRoutine(routine: Pick<Routine, "reasoning">): boolean {
  return routine.reasoning.promptId === BRIEF_PROMPT_ID;
}

// ---- rendering ----

function dateIn(iso: string, tz: string): string {
  return new Date(iso).toLocaleString("sv-SE", { timeZone: tz }).slice(0, 16);
}

function itemLine(i: BriefItem, tz: string, overdueWord: string): string {
  const due = i.dueAt ? ` (${dateIn(i.dueAt, tz)}${i.overdue ? `, ${overdueWord}` : ""})` : "";
  return `- ${i.title}${due} [${i.itemId}]`;
}

const LABELS = {
  ja: {
    subject: "朝のブリーフ",
    window: "対象期間",
    handled: "オートパイロットの処理",
    runsLine: (b: MorningBrief["handled"]) =>
      `実行 ${b.runs} 回 / 案件 ${b.items} 件 / 準備 ${b.prepared} / 実行済み ${b.acted} / 人の確認待ち ${b.escalated} / 人手なしで完了 ${b.handled} / 返信下書き ${b.drafts}`,
    area: "部門・領域別",
    documents: "作成した文書",
    decisions: "あなたの判断待ち",
    flagged: "あなたが確認・解除できるフラグ付き案件",
    proposals: "承認できる自律レベルの提案",
    commitments: "期限が近い案件",
    linked: "対応が必要な部門間連携案件",
    linkedReady: "開始可能な工程",
    linkedMissing: "子案件が見つからない工程",
    linkedBlocked: "取消・停止した工程あり",
    linkedUnreadable: "連携記録を読み取れません",
    notifications: "通知",
    notificationsUnread: (n: number) => `未読 ${n} 件`,
    notificationsUnreadable: "通知記録を読み取れません",
    problems: "問題",
    none: "なし",
    overdue: "期限超過",
    watchdog: "ウォッチドッグ停止",
    runFailed: "失敗した実行",
    runSkipped: "スキップされた実行",
    demoted: "レベル引き下げ",
    paused: "一時停止中",
    routinesError: "ルーティン定義が無効です",
    stopped: "全ルーティン停止中",
    more: "ほかにもあります（コンソールで確認してください）",
    footer: "このブリーフは記録データのみから作成され、送信はされていません。",
  },
  en: {
    subject: "Morning brief",
    window: "Window",
    handled: "What the autopilot handled",
    runsLine: (b: MorningBrief["handled"]) =>
      `${b.runs} runs / ${b.items} items / ${b.prepared} prepared / ${b.acted} acted / ${b.escalated} waiting for a person / ${b.handled} handled without a person / ${b.drafts} reply drafts`,
    area: "By department or area",
    documents: "Documents prepared",
    decisions: "Waiting for your decision",
    flagged: "Flagged items you may clear",
    proposals: "Autonomy proposals you may accept",
    commitments: "Commitments due",
    linked: "Linked cases that need a person",
    linkedReady: "steps ready to open",
    linkedMissing: "steps whose child item is missing",
    linkedBlocked: "a step is cancelled or stuck",
    linkedUnreadable: "the linked case record cannot be read",
    notifications: "Notifications",
    notificationsUnread: (n: number) => `${n} unread`,
    notificationsUnreadable: "the notification record cannot be read",
    problems: "Problems",
    none: "none",
    overdue: "overdue",
    watchdog: "Watchdog trip",
    runFailed: "Failed run",
    runSkipped: "Skipped run",
    demoted: "Level lowered",
    paused: "Paused",
    routinesError: "The routines file is invalid",
    stopped: "Every routine is stopped",
    more: "More not shown (open the console)",
    footer: "This brief is built from recorded data only. Nothing was sent.",
  },
} as const;

/** The brief as plain text in one language. */
export function renderBrief(b: MorningBrief, lang: "ja" | "en", tz = "Asia/Tokyo"): string {
  const L = LABELS[lang];
  const out: string[] = [];
  const section = (title: string, lines: string[], cut = false) => {
    out.push("", `■ ${title}`, ...(lines.length ? lines : [`- ${L.none}`]));
    if (cut) {
      out.push(`- ${L.more}`);
    }
  };
  const cut = b.truncated;
  out.push(
    `${L.subject}: ${b.projectName}${b.name ? ` / ${b.name}` : ""}`,
    `${L.window}: ${dateIn(b.window.from, tz)} - ${dateIn(b.window.to, tz)} (${tz})`,
  );
  section(L.handled, [
    `- ${L.runsLine(b.handled)}`,
    ...b.handled.areas.map(
      (a) =>
        `  - ${L.area} ${a.department ?? a.area}: ${a.runs} / ${a.items} / ${a.prepared} / ${a.handled}`,
    ),
  ]);
  section(
    L.documents,
    b.documents.map((d) => `- ${d.path} (${d.routineId})`),
    cut.documents,
  );
  section(
    L.decisions,
    b.waiting.decisions.map((i) => itemLine(i, tz, L.overdue)),
    cut.decisions,
  );
  section(
    L.flagged,
    b.waiting.flagged.map((i) => `${itemLine(i, tz, L.overdue)} ${i.flags.join(", ")}`),
    cut.flagged,
  );
  section(
    L.proposals,
    b.waiting.proposals.map(
      (p) =>
        `- ${p.routineId}: ${p.current} → ${p.proposed} (${p.reason}${p.acceptBlocker ? `, ${p.acceptBlocker}` : ""})`,
    ),
  );
  section(
    L.commitments,
    b.commitments.map((i) => itemLine(i, tz, L.overdue)),
    cut.commitments,
  );
  section(
    L.linked,
    (b.waiting.linked ?? []).map((c) => {
      const notes = c.unreadable
        ? [L.linkedUnreadable]
        : [
            `${c.done}/${c.total}`,
            ...(c.ready.length ? [`${L.linkedReady}: ${c.ready.join(", ")}`] : []),
            ...(c.missing.length ? [`${L.linkedMissing}: ${c.missing.join(", ")}`] : []),
            ...(c.blocked ? [L.linkedBlocked] : []),
          ];
      return `${itemLine(c, tz, L.overdue)} (${notes.join("; ")})`;
    }),
    cut.linked,
  );
  const n = b.waiting.notifications;
  if (n) {
    section(L.notifications, [
      `- ${n.unreadable ? L.notificationsUnreadable : L.notificationsUnread(n.unread)}`,
    ]);
  }
  section(L.problems, [
    ...(b.problems.control.stopped || b.problems.control.emergencyStop ? [`- ${L.stopped}`] : []),
    ...(b.problems.routinesError ? [`- ${L.routinesError}: ${b.problems.routinesError}`] : []),
    ...b.problems.watchdog.map((w) => `- ${L.watchdog}: ${w.routineId} (${w.reasons.join("; ")})`),
    ...b.problems.runs.map(
      (r) =>
        `- ${r.status === "failed" ? L.runFailed : L.runSkipped}: ${r.routineId} [${r.runId}]${r.reason ? ` ${r.reason}` : ""}`,
    ),
    ...b.problems.demotions.map(
      (d) => `- ${L.demoted}: ${d.routineId} ${d.from} → ${d.to} (${d.cause})`,
    ),
    ...b.problems.paused.map((p) => `- ${L.paused}: ${p.routineId} (${p.pausedBy ?? "?"})`),
  ]);
  out.push("", L.footer);
  return out.join("\n");
}

/** Japanese first, then English: the text a delivered brief carries. */
export function renderBriefText(
  b: MorningBrief,
  tz = "Asia/Tokyo",
): {
  subject: string;
  body: string;
} {
  const day = dateIn(b.window.to, tz).slice(0, 10);
  return {
    subject: `${LABELS.ja.subject} / ${LABELS.en.subject}: ${b.projectName} ${day}`.slice(0, 255),
    body: `${renderBrief(b, "ja", tz)}\n\n----------------------------------------\n\n${renderBrief(b, "en", tz)}\n`,
  };
}

// ---- delivery to output/briefs/ ----

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** True when the Project's mode and rules let the engine write `output/briefs/`. */
export function briefFolderWritable(project: Project): boolean {
  return writableForMode(project).some(
    (w) => w === "." || w === "output" || w === BRIEF_DIR || BRIEF_DIR.startsWith(`${w}/`),
  );
}

/**
 * Write the brief to `output/briefs/<day>-<principal>.md` (a new file, never over an existing
 * one, never through a symbolic link out of the Project). Returns the Project-relative path.
 */
export function writeBriefFile(
  project: Project,
  principal: string,
  text: { subject: string; body: string },
  day: string,
): string {
  if (!briefFolderWritable(project)) {
    throw new Error(`${BRIEF_DIR} is not writable in this Project's mode`);
  }
  const root = fs.realpathSync(project.folder);
  const dir = path.join(root, BRIEF_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isInside(root, fs.realpathSync(dir))) {
    throw new Error(`${BRIEF_DIR} leads outside the Project folder`);
  }
  const slug = principal.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 64) || "person";
  for (let n = 1; n <= 50; n++) {
    const name = `${day}-${slug}${n > 1 ? `-${n}` : ""}.md`;
    try {
      const fd = fs.openSync(path.join(dir, name), "wx", 0o600);
      try {
        fs.writeSync(fd, `# ${text.subject}\n\n${text.body}`);
      } finally {
        fs.closeSync(fd);
      }
      return `${BRIEF_DIR}/${name}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
  }
  throw new Error("too many briefs for this person today");
}
