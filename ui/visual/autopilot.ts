import { html, render } from "lit";
import "../src/styles.css";
import type {
  AutopilotRoutinesListResult,
  AutopilotRunsListResult,
} from "../../packages/client/src/generated/types";
import {
  emptyAutopilot,
  type AutopilotState,
  type AutopilotFilters,
} from "../src/ui/controllers/autopilot";
import { setLocale } from "../src/ui/i18n";
import { renderAutopilot } from "../src/ui/views/autopilot";

const params = new URLSearchParams(location.search);
const locale = params.get("locale") === "ja" ? "ja" : "en";
setLocale(locale);
document.body.className = "industrial-visual-fixture";
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
const routine: AutopilotRoutinesListResult["routines"][number] = {
  id: "fictional-design-review",
  edition: "industrial",
  area: "design-docs",
  department: null,
  name: { en: "Prepare design review", ja: "設計レビューの準備" },
  enabled: true,
  trigger: { kind: "schedule", expr: "0 9 * * 1-5", tz: "Asia/Tokyo" },
  agentId: null,
  gather: [],
  knowledge: [],
  reasoning: {
    promptId: null,
    schemaId: "fixture",
    backend: null,
    model: null,
    timeoutSeconds: 30,
  },
  actions: [
    { id: "legacy.design_doc", class: "prepare", label: { en: "Design document", ja: "設計書" } },
  ],
  level: "L2",
  effectiveLevel: "L1",
  override: {
    level: "L1",
    kind: "demoted",
    by: "watchdog",
    at: "2026-10-25T00:00:00+09:00",
    reason: locale === "ja" ? "操作数の上限を超えました" : "Action limit exceeded",
    changeId: "fictional-change",
  },
  lastDemotion: {
    from: "L2",
    to: "L1",
    cause: "watchdog",
    by: "watchdog",
    at: "2026-10-25T00:00:00+09:00",
    reason: locale === "ja" ? "操作数の上限を超えました" : "Action limit exceeded",
    runId: "fictional-run",
    itemId: null,
    changeId: "fictional-change",
  },
  limits: { maxItemsPerRun: 10, maxActionsPerDay: 20 },
  requireCitations: false,
  baselineMinutes: null,
  queue: null,
  state: {
    paused: true,
    pausedBy: "watchdog",
    pausedAt: "2026-10-25T00:00:00+09:00",
    pauseReason:
      locale === "ja" ? "設計資料の確認待ち" : "Waiting for a person to verify source documents",
    cronJobId: "fictional-cron",
    lastRunId: "fictional-run",
    lastRunAt: "2026-10-24T09:00:00+09:00",
    lastStatus: "escalated",
    actionsToday: 0,
    triggers: [],
    watchdog: {
      baseline: "static",
      runs: 0,
      thresholds: {
        gatherCalls: 50,
        bytesRead: 1000000,
        items: 100,
        actions: 20,
        durationMs: 600000,
      },
      p95: null,
      lastTrip: null,
      trips: 0,
      toolUseStreak: 0,
    },
  },
};
const run: AutopilotRunsListResult["runs"][number] = {
  id: "fictional-run",
  projectId: "fictional-plant",
  routineId: routine.id,
  edition: "industrial",
  area: "design-docs",
  level: "L1",
  trigger: "schedule",
  triggeredBy: "fixture",
  startedAt: "2026-10-24T09:00:00+09:00",
  endedAt: "2026-10-24T09:01:00+09:00",
  status: "escalated",
  reason: null,
  routineDigest: "fictional",
  reasoning: { backend: null, model: null, ms: 0, outputSha256: null },
  counts: {
    items: 15,
    prepared: 14,
    acted: 0,
    escalated: 1,
    refused: 0,
    failed: 0,
    handled: 14,
    deferred: 0,
  },
  workItems: [],
  evidence: null,
};
const financeRoutine = {
  ...routine,
  id: "fictional-finance-review",
  override: {
    level: "L1" as const,
    kind: "accepted" as const,
    by: "fictional-reviewer",
    at: "2026-10-25T00:00:00+09:00",
    reason: locale === "ja" ? "準備のみを承認" : "Preparation only accepted",
    changeId: "fictional-finance-change",
  },
  lastDemotion: null,
  edition: "business" as const,
  area: "finance",
  department: "finance",
  name: { en: "Prepare invoice review", ja: "請求書レビューの準備" },
  actions: [
    {
      id: "invoice.review",
      class: "prepare" as const,
      label: { en: "Invoice review", ja: "請求書レビュー" },
    },
  ],
  state: {
    ...routine.state,
    paused: false,
    pausedBy: null,
    pausedAt: null,
    pauseReason: null,
  },
};
const olderRun = {
  ...run,
  id: "fictional-older-run",
  startedAt: "2026-10-23T09:00:00+09:00",
  endedAt: "2026-10-23T09:01:00+09:00",
};
const financeRun = {
  ...run,
  id: "fictional-finance-run",
  routineId: financeRoutine.id,
  counts: { ...run.counts, items: 30, prepared: 29, handled: 29 },
  edition: "business" as const,
  area: "finance",
};
const state = {
  inspectAutopilotRun: async (id: string) => {
    const selected = state.autopilot.runs?.runs.find((entry) => entry.id === id);
    if (!selected) {
      return;
    }
    state.autopilot.selectedRunId = id;
    state.autopilot.runDetail = {
      run: {
        ...selected,
        gather: [
          { id: "fictional-source", tool: "project.read", calls: 1, bytes: 240, error: null },
        ],
        actions: [
          {
            item: "fictional-invoice",
            kind: "invoice.review",
            class: "prepare",
            decision: "needs_person",
            executed: false,
            code: null,
            error: null,
            approvalId: null,
            ref: null,
          },
        ],
      },
      evidence: {
        ok: false,
        problems: [
          locale === "ja"
            ? "表示確認用データには証跡バンドルがありません。"
            : "Visual fixture has no evidence bundle.",
        ],
      },
    };
    draw();
  },
  closeAutopilotRun: () => {
    state.autopilot.selectedRunId = null;
    state.autopilot.runDetail = null;
    draw();
  },
  canDeclineAutonomy: true,
  setAutopilotRoutineReason: (routineId: string, reason: string) => {
    state.autopilot.routineReasons[routineId] = reason;
    draw();
  },
  changeAutopilotRoutine: async (routineId: string, action: "pause" | "resume") => {
    const entry = state.autopilot.routines?.routines.find((item) => item.id === routineId);
    const reason = state.autopilot.routineReasons[routineId]?.trim() ?? "";
    if (
      !entry ||
      reason.length > 1000 ||
      (action === "pause" && (!reason || entry.state.paused)) ||
      (action === "resume" &&
        (!entry.state.paused ||
          state.autopilot.routines?.control.stopped ||
          (["watchdog", "stopAll"].includes(entry.state.pausedBy ?? "") && reason.length < 4)))
    ) {
      return;
    }
    entry.state = {
      ...entry.state,
      paused: action === "pause",
      pausedBy: action === "pause" ? "fictional-reviewer" : null,
      pausedAt: action === "pause" ? "2026-10-25T09:00:00+09:00" : null,
      pauseReason: action === "pause" ? reason : null,
    };
    state.autopilot.routineReasons[routineId] = "";
    state.autopilot.routineStatus = action === "pause" ? "routinePaused" : "routineResumed";
    draw();
  },
  setAutonomyDeclineReason: (routineId: string, reason: string) => {
    state.autopilot.declineReasons[routineId] = reason;
    draw();
  },
  acceptAutonomy: async (routineId: string) => {
    const proposal = state.autopilot.autonomy?.proposals.find(
      (entry) => entry.routineId === routineId,
    );
    const entry = state.autopilot.routines?.routines.find((item) => item.id === routineId);
    const reason = state.autopilot.declineReasons[routineId]?.trim() ?? "";
    if (
      !proposal ||
      !entry ||
      proposal.kind === "hold" ||
      proposal.declined ||
      proposal.acceptBlocker !== null ||
      reason.length < 4 ||
      reason.length > 1000
    ) {
      return;
    }
    entry.effectiveLevel = proposal.proposed;
    entry.override =
      entry.level === proposal.proposed
        ? null
        : {
            level: proposal.proposed,
            kind: "accepted",
            by: "fictional-reviewer",
            at: "2026-10-25T12:00:00+09:00",
            reason,
            changeId: "fictional-acceptance",
          };
    proposal.current = proposal.proposed;
    proposal.proposed = "L3";
    proposal.acceptBlocker = "above_file_level";
    proposal.needsStandingApproval = true;
    state.autopilot.declineReasons[routineId] = "";
    state.autopilot.acceptStatus = "acceptSaved";
    draw();
  },
  declineAutonomy: async (routineId: string) => {
    const proposal = state.autopilot.autonomy?.proposals.find(
      (entry) => entry.routineId === routineId,
    );
    const reason = state.autopilot.declineReasons[routineId]?.trim();
    if (!proposal || !reason || reason.length < 4 || reason.length > 1000) {
      return;
    }
    proposal.declined = { by: "fictional-reviewer", at: "2026-10-25T08:00:00+09:00", reason };
    state.autopilot.declineStatus = "declineSaved";
    draw();
  },
  connected: true,
  locale,
  refreshAutopilot: async (cursor?: string) => {
    document.querySelector("#fixture")!.setAttribute("data-refreshed", "true");
    state.autopilot.selectedRunId = null;
    state.autopilot.runDetail = null;
    state.autopilot.cursor = cursor ?? null;
    const matching = [run, olderRun, financeRun].filter(
      (entry) =>
        (!state.autopilot.filters.edition || entry.edition === state.autopilot.filters.edition) &&
        (!state.autopilot.filters.area || entry.area === state.autopilot.filters.area),
    );
    const offset = cursor === "fictional-last" ? 2 : cursor ? 1 : 0;
    state.autopilot.runs = {
      runs: matching.slice(offset, offset + 1),
      total: matching.length,
      nextCursor:
        offset + 1 < matching.length ? (offset === 0 ? "fictional-older" : "fictional-last") : null,
    };
    draw();
  },
  setAutopilotFilters: async (filters: AutopilotFilters) => {
    state.autopilot.filters = filters;
    await state.refreshAutopilot();
  },
  autopilot: {
    ...emptyAutopilot(),
    projectId: "fictional-plant",
    brief: {
      version: 1,
      projectId: "fictional-plant",
      projectName: "Fictional plant",
      principal: "person:alice",
      name: "Alice",
      generatedAt: new Date().toISOString(),
      window: { from: "2026-10-24T00:00:00Z", to: "2026-10-25T00:00:00Z" },
      handled: {
        runs: 3,
        items: 8,
        prepared: 4,
        acted: 1,
        escalated: 2,
        handled: 5,
        failedRuns: 1,
        drafts: 2,
        areas: [],
      },
      documents: [
        {
          runId: "fictional-run",
          routineId: "fictional-review",
          path: "output/review/fictional-document-with-a-long-unbroken-filename-to-check-mobile-layout.md",
          at: "2026-10-25T00:00:00Z",
        },
      ],
      waiting: {
        decisions: [
          {
            projectId: "fictional-plant",
            itemId: "fictional-item",
            title: locale === "ja" ? "設備点検の承認" : "Approve equipment inspection",
            queue: "operations",
            status: "review",
            priority: "high",
            dueAt: "2026-10-24T00:00:00Z",
            overdue: true,
          },
        ],
        flagged: [],
        proposals: [],
      },
      commitments: [],
      problems: {
        watchdog: [],
        runs: [],
        demotions: [],
        paused: [],
        routinesError: null,
        control: { stopped: false, emergencyStop: false },
      },
    },
    routines: {
      routines: [routine, financeRoutine],
      source: { kind: "template" as const, path: null },
      digest: "fictional",
      error: null,
      catalogue: [],
      editions: {},
      flags: [],
      control: { stopped: false, by: null, at: null, reason: null, emergencyStop: false },
    },
    runs: { runs: [run], total: 3, nextCursor: "fictional-older" as string | null },
    autonomy: {
      policy: {
        windowDays: 30,
        minItemsToPromote: 20,
        promoteAtOrBelow: 0.05,
        minItemsToDemote: 10,
        demoteAtOrAbove: 0.2,
      },
      proposals: [routine, financeRoutine].map((entry) => ({
        routineId: entry.id,
        current: entry.effectiveLevel,
        fileLevel: entry.level,
        acceptBlocker: null,
        kind: "promote" as const,
        proposed: "L2" as const,
        reason: "low_correction_rate" as const,
        needsStandingApproval: false,
        declined:
          entry.id === financeRoutine.id
            ? {
                by: "fictional-reviewer",
                at: "2026-10-25T07:00:00+09:00",
                reason: locale === "ja" ? "追加確認が必要です" : "Further review required",
              }
            : null,
        evidence: {
          from: "2026-09-25T00:00:00+09:00",
          to: "2026-10-25T00:00:00+09:00",
          runs: entry.id === financeRoutine.id ? 1 : 2,
          failedRuns: 0,
          workItems: 30,
          corrected: entry.id === financeRoutine.id ? 1 : 0,
          correctionRate: entry.id === financeRoutine.id ? 1 / 30 : 0,
          escalated: entry.id === financeRoutine.id ? 1 : 2,
        },
      })),
    },
    stats: {
      from: null,
      to: null,
      routines: [],
      areas: [],
      totals: {
        runs: 3,
        failedRuns: 0,
        items: 60,
        prepared: 57,
        acted: 0,
        escalated: 3,
        handled: 57,
        correctedByPerson: 1,
        minutesSaved: null,
      },
      control: { stopped: false, by: null, at: null, reason: null, emergencyStop: false },
    },
  } as AutopilotState,
};
function draw() {
  render(
    html`<p>${locale === "ja" ? "架空の工場 · 表示確認用データ" : "Fictional plant · visual fixture data"}</p>
  ${renderAutopilot(state, { id: "fictional-plant" })}`,
    document.querySelector("#fixture")!,
  );
}
draw();
