import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AutopilotRoutinesListResult,
  AutopilotRunsListResult,
} from "../../../../packages/client/src/generated/types";
import { emptyAutopilot } from "../controllers/autopilot";
import { setLocale } from "../i18n";
import { renderAutopilot } from "./autopilot";

const routine: AutopilotRoutinesListResult["routines"][number] = {
  id: "receipt",
  edition: "business",
  area: "finance",
  department: null,
  name: { en: "Receipt review", ja: "領収書確認" },
  enabled: false,
  trigger: { kind: "interval", minutes: 30 },
  agentId: null,
  gather: [],
  knowledge: [],
  reasoning: { promptId: null, schemaId: "s", backend: null, model: null, timeoutSeconds: 30 },
  actions: [{ id: "draft", class: "prepare", label: { en: "Draft", ja: "下書き" } }],
  level: "L1",
  effectiveLevel: "L1",
  override: null,
  lastDemotion: null,
  limits: { maxItemsPerRun: 10, maxActionsPerDay: 10 },
  requireCitations: true,
  baselineMinutes: null,
  queue: null,
  state: {
    paused: true,
    pausedBy: "owner",
    pausedAt: null,
    pauseReason: "Review pending",
    cronJobId: null,
    lastRunId: null,
    lastRunAt: null,
    lastStatus: null,
    actionsToday: 0,
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
    triggers: [],
  },
};
const box = document.createElement("div");
afterEach(() => {
  render(null, box);
  setLocale("en");
});
function state() {
  return {
    reportAutopilotError: vi.fn(async () => {}),
    setAutopilotReportReason: vi.fn(),
    inspectAutopilotRun: vi.fn(async () => {}),
    closeAutopilotRun: vi.fn(),
    setAutopilotRoutineReason: vi.fn(),
    changeAutopilotRoutine: vi.fn(async () => {}),
    canDeclineAutonomy: false,
    setAutonomyDeclineReason: vi.fn(),
    declineAutonomy: vi.fn(async () => {}),
    acceptAutonomy: vi.fn(async () => {}),
    connected: true,
    locale: "en",
    refreshAutopilot: vi.fn(async () => {}),
    setAutopilotFilters: vi.fn(async () => {}),
    autopilot: {
      ...emptyAutopilot(),
      projectId: "p1",
      routines: {
        routines: [routine],
        source: { kind: "project" as AutopilotRoutinesListResult["source"]["kind"], path: null },
        digest: "d",
        error: null as string | null,
        catalogue: [],
        editions: {},
        flags: [],
        control: { stopped: false, by: null, at: null, reason: null, emergencyStop: false },
      },
      runs: { runs: [], total: 4, nextCursor: null } as AutopilotRunsListResult,
      stats: {
        from: null,
        to: null,
        routines: [],
        areas: [],
        totals: {
          runs: 4,
          failedRuns: 0,
          items: 5,
          prepared: 2,
          acted: 1,
          escalated: 1,
          handled: 3,
          correctedByPerson: 0,
          minutesSaved: null,
        },
        control: { stopped: false, by: null, at: null, reason: null, emergencyStop: false },
      },
    },
  };
}
describe("Autopilot panel", () => {
  it.each(["en", "ja"])("announces an uncertain write while a new scope loads in %s", (locale) => {
    const s = state();
    s.locale = locale;
    setLocale(locale);
    s.autopilot = { ...s.autopilot, projectId: "p2", loading: true, mutationDelayed: true };
    render(renderAutopilot(s, { id: "p2" }), box);
    const notice =
      locale === "ja" ? "結果はまだ確認できていません" : "Its outcome is not yet confirmed";
    expect(
      [...box.querySelectorAll('[role="status"]')].some((node) =>
        node.textContent?.includes(notice),
      ),
    ).toBe(true);
    s.autopilot.mutationDelayed = false;
    render(renderAutopilot(s, { id: "p2" }), box);
    expect(box.textContent).not.toContain(notice);
  });
  it.each(["en", "ja"])(
    "shows the effective level, ceiling and historical demotion in %s",
    (locale) => {
      const s = state();
      s.locale = locale;
      setLocale(locale);
      s.autopilot.routines.routines = [
        {
          ...routine,
          level: "L3",
          effectiveLevel: "L1",
          override: {
            level: "L1",
            kind: "demoted",
            by: "watchdog",
            at: "2026-10-25T00:00:00Z",
            reason: "Action limit exceeded",
            changeId: "change1",
          },
          lastDemotion: {
            from: "L2",
            to: "L1",
            cause: "watchdog",
            by: "watchdog",
            at: "2026-10-25T00:00:00Z",
            reason: "Action limit exceeded",
            runId: "run1",
            itemId: null,
            changeId: "change1",
          },
        },
      ];
      render(renderAutopilot(s, { id: "p1" }), box);
      const card = box.querySelector('[data-routine-id="receipt"]')!;
      expect(card.querySelector("h4")!.textContent).toContain("L1");
      expect(card.querySelector("h4")!.textContent).not.toContain("L3");
      expect(card.querySelector("[data-autonomy-levels]")!.textContent).toContain(
        locale === "en" ? "Effective level: L1" : "実効レベル: L1",
      );
      expect(card.querySelector("[data-autonomy-levels]")!.textContent).toContain(
        locale === "en" ? "File ceiling: L3" : "ファイルの上限: L3",
      );
      expect(card.querySelector("[data-last-demotion]")!.textContent).toContain(
        locale === "en" ? "Last automatic reduction" : "前回の自動引き下げ",
      );
      expect(card.querySelector("[data-last-demotion]")!.textContent).toContain(
        "Action limit exceeded",
      );
      expect(card.querySelector("[data-last-demotion]")!.textContent).not.toContain("autopilot.");
      expect(s.changeAutopilotRoutine).not.toHaveBeenCalled();
      expect(s.declineAutonomy).not.toHaveBeenCalled();
    },
  );

  it("keeps a past demotion historical after restoration and uses server effective level", () => {
    const s = state();
    s.autopilot.routines.routines = [
      {
        ...routine,
        level: "L2",
        effectiveLevel: "L2",
        override: null,
        lastDemotion: {
          from: "L2",
          to: "L1",
          cause: "reported_error",
          by: "reviewer",
          at: "2026-10-25T00:00:00Z",
          reason: "Incorrect draft",
          runId: null,
          itemId: "item1",
          changeId: "change1",
        },
      },
    ];
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.querySelector('[data-routine-id="receipt"] h4')!.textContent).toContain("L2");
    expect(box.querySelector("[data-level-override]")).toBeNull();
    expect(box.querySelector("[data-last-demotion]")!.textContent).toContain(
      "Serious error reported by reviewer",
    );
    expect(box.querySelector("[data-last-demotion]")!.textContent).toContain("Incorrect draft");
    s.autopilot.routines.routines[0] = {
      ...routine,
      level: "L1",
      effectiveLevel: "L1",
      override: {
        level: "L2",
        kind: "accepted",
        by: "reviewer",
        at: "2026-10-25T00:00:00Z",
        reason: "Accepted before ceiling changed",
        changeId: "change2",
      },
    };
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.querySelector('[data-routine-id="receipt"] h4')!.textContent).toContain("L1");
    expect(box.querySelector("[data-level-override]")!.textContent).toContain(
      "Level accepted by reviewer",
    );
    expect(box.querySelector("[data-last-demotion]")).toBeNull();
  });

  it("omits missing level history and hides another Project's history", () => {
    const s = state();
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.querySelector("[data-level-override]")).toBeNull();
    expect(box.querySelector("[data-last-demotion]")).toBeNull();
    render(renderAutopilot(s, { id: "other" }), box);
    expect(box.querySelector("[data-autonomy-levels]")).toBeNull();
    expect(box.textContent).not.toContain("Receipt review");
  });

  it("shows scoped proposal evidence, approval guidance and person-only decline form", () => {
    const s = state();
    s.autopilot.autonomy = {
      policy: {
        windowDays: 14,
        minItemsToPromote: 30,
        promoteAtOrBelow: 0.03,
        minItemsToDemote: 5,
        demoteAtOrAbove: 0.4,
      },
      proposals: [
        {
          routineId: "receipt",
          current: "L2",
          kind: "promote",
          proposed: "L3",
          reason: "low_correction_rate",
          needsStandingApproval: true,
          fileLevel: "L3",
          acceptBlocker: "no_standing_approval",
          declined: null,
          evidence: {
            from: "2026-10-01T00:00:00Z",
            to: "2026-10-15T00:00:00Z",
            runs: 12,
            failedRuns: 0,
            workItems: 37,
            corrected: 1,
            correctionRate: 1 / 37,
            escalated: 2,
          },
        },
      ],
    };
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain("Receipt review · Proposed increase");
    expect(box.textContent).toContain("Evidence window: 14 days");
    expect(box.textContent).toContain("at least 30 work items");
    expect(box.textContent).toContain("Correction rate: 2.7%");
    expect(box.textContent).toContain("Work items37");
    expect(box.textContent).toContain("External actions also require a standing approval");
    expect(box.querySelectorAll("button")).toHaveLength(1);
    const proposal = s.autopilot.autonomy.proposals[0];
    proposal.acceptBlocker = "above_file_level";
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.querySelector("[data-accept-blocker]")!.textContent).toContain(
      "exceeds the file ceiling",
    );
    proposal.acceptBlocker = "no_standing_approval";
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.querySelector("[data-accept-blocker]")!.textContent).toContain(
      "active standing approval is required",
    );
    proposal.acceptBlocker = null;
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.querySelector("[data-accept-blocker]")).toBeNull();

    s.canDeclineAutonomy = true;
    render(renderAutopilot(s, { id: "p1" }), box);
    const reason = box.querySelector<HTMLTextAreaElement>("[data-autonomy] textarea")!;
    expect(reason.maxLength).toBe(1000);
    expect(reason.minLength).toBe(4);
    expect(
      box.querySelector<HTMLButtonElement>('[data-autonomy] button[type="submit"]')!.disabled,
    ).toBe(true);
    reason.value = "Review first";
    reason.dispatchEvent(new Event("input", { bubbles: true }));
    expect(s.setAutonomyDeclineReason).toHaveBeenCalledWith("receipt", "Review first");
    s.autopilot.declineReasons.receipt = "Review first";
    render(renderAutopilot(s, { id: "p1" }), box);
    box
      .querySelector("[data-autonomy] form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(s.declineAutonomy).toHaveBeenCalledWith("receipt");
    s.autopilot.declinePending = "receipt";
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(
      box.querySelector<HTMLButtonElement>('[data-autonomy] button[type="submit"]')!.disabled,
    ).toBe(true);
    s.autopilot.declinePending = null;
    s.autopilot.autonomy.proposals[0].declined = {
      by: "reviewer",
      at: "2026-10-25T00:00:00Z",
      reason: "Review first",
    };
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain("Declined by reviewer");
    expect(box.textContent).toContain("Review first");
    expect(box.querySelector<HTMLTextAreaElement>("[data-autonomy] textarea")).toBeNull();
    s.autopilot.autonomy.proposals[0].evidence.correctionRate = null;
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain("Correction rate: Unknown");
    s.autopilot.filters = { edition: "core" };
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).not.toContain("Receipt review · Proposed increase");
    expect(box.textContent).toContain("No proposals for the selected routines");
    s.autopilot.filters = {};
    s.locale = "ja";
    setLocale("ja");
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain("自律レベルの提案");
    expect(box.textContent).toContain("領収書確認 · 引き上げの提案");
    expect(box.textContent).toContain("修正率: 不明");
    s.autopilot.autonomy = null;
    s.autopilot.autonomyError = true;
    setLocale("en");
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain("Proposals are unavailable");
    expect(box.textContent).toContain("Showing 0 of 4 runs");
  });
  it.each(["en", "ja"])("gates Accept and shares mutation controls in %s", (locale) => {
    const s = state();
    s.locale = locale;
    setLocale(locale);
    s.canDeclineAutonomy = true;
    s.autopilot.declineReasons.receipt = "Reviewed evidence";
    s.autopilot.autonomy = {
      policy: {
        windowDays: 30,
        minItemsToPromote: 20,
        promoteAtOrBelow: 0.05,
        minItemsToDemote: 10,
        demoteAtOrAbove: 0.2,
      },
      proposals: [
        {
          routineId: "receipt",
          current: "L1",
          proposed: "L2",
          fileLevel: "L2",
          kind: "promote",
          reason: "low_correction_rate",
          acceptBlocker: null,
          declined: null,
          needsStandingApproval: false,
          evidence: {
            from: "2026-10-01T00:00:00Z",
            to: "2026-10-25T00:00:00Z",
            runs: 20,
            failedRuns: 0,
            workItems: 30,
            corrected: 0,
            correctionRate: 0,
            escalated: 0,
          },
        },
      ],
    };
    const draw = () => render(renderAutopilot(s, { id: "p1" }), box);
    const accept = () => box.querySelector<HTMLButtonElement>("[data-accept-proposal]");
    draw();
    expect(accept()!.disabled).toBe(false);
    expect(accept()!.type).toBe("button");
    accept()!.click();
    expect(s.acceptAutonomy).toHaveBeenCalledExactlyOnceWith("receipt");
    expect(s.declineAutonomy).not.toHaveBeenCalled();
    for (const pending of [
      "acceptPending",
      "declinePending",
      "routinePending",
      "reportPending",
    ] as const) {
      s.autopilot[pending] = "other";
      draw();
      expect(accept()!.disabled).toBe(true);
      expect(
        [...box.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].every(
          (button) => button.disabled,
        ),
      ).toBe(true);
      expect(
        [...box.querySelectorAll<HTMLTextAreaElement>("textarea")].every((input) => input.disabled),
      ).toBe(true);
      s.autopilot[pending] = null;
    }
    const proposal = s.autopilot.autonomy.proposals[0];
    for (const blocker of ["above_file_level", "no_standing_approval"] as const) {
      proposal.acceptBlocker = blocker;
      draw();
      expect(accept()!.disabled).toBe(true);
      expect(
        box.querySelector<HTMLButtonElement>('[data-autonomy] button[type="submit"]')!.disabled,
      ).toBe(false);
    }
    proposal.acceptBlocker = null;
    for (const reason of ["", "   abc   ", "x".repeat(1001)]) {
      s.autopilot.declineReasons.receipt = reason;
      draw();
      expect(accept()!.disabled).toBe(true);
    }
    s.autopilot.declineReasons.receipt = "Reviewed evidence";
    s.connected = false;
    draw();
    expect(accept()).toBeNull();
    s.connected = true;
    s.canDeclineAutonomy = false;
    draw();
    expect(accept()).toBeNull();
    s.canDeclineAutonomy = true;
    proposal.kind = "hold";
    draw();
    expect(accept()).toBeNull();
    proposal.kind = "demote";
    proposal.proposed = "L0";
    draw();
    expect(accept()!.disabled).toBe(false);
    proposal.declined = { by: "reviewer", at: "2026-10-25T00:00:00Z", reason: "Review first" };
    draw();
    expect(accept()).toBeNull();
    s.autopilot.acceptStatus = "acceptFailed";
    draw();
    expect(box.textContent).toContain(
      locale === "ja" ? "承認結果を確認できませんでした" : "Acceptance could not be confirmed",
    );
    render(renderAutopilot(s, { id: "other" }), box);
    expect(accept()).toBeNull();
  });
  it("renders server policy, totals, unknown minutes and only a read refresh button", () => {
    const s = state();
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain("Receipt review · L1");
    expect(box.textContent).toContain("Disabled · Paused · No scheduled job registered");
    expect(box.textContent).toContain("Draft (Prepare)");
    expect(box.textContent).toContain("Project totals · all editions · all recorded time");
    expect(box.textContent).toContain("Minutes savedUnknown");
    expect(box.textContent).toContain("Showing 0 of 4 runs");
    expect(box.querySelectorAll("button").length).toBe(1);
    box.querySelector("button")!.click();
    expect(s.refreshAutopilot).toHaveBeenCalledOnce();
  });
  it("filters configured routines locally, keeps server totals, and exposes labeled controls", () => {
    const s = state();
    s.autopilot.filters = { edition: "core", area: "historical-area" };
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).not.toContain("Receipt review");
    expect(box.textContent).toContain("No routines match these filters");
    expect(box.textContent).toContain("Showing 0 of 4 runs");
    expect(box.textContent).toContain("Project totals include all editions and areas");
    const edition = box.querySelector<HTMLSelectElement>('select[aria-label="Edition"]')!;
    const area = box.querySelector<HTMLSelectElement>('select[aria-label="Area"]')!;
    expect(edition.value).toBe("core");
    expect(area.value).toBe("historical-area");
    expect([...area.options].map((option) => option.value)).toEqual(["", "historical-area"]);
    edition.value = "business";
    edition.dispatchEvent(new Event("change", { bubbles: true }));
    expect(s.setAutopilotFilters).toHaveBeenCalledWith({ edition: "business" });
    area.value = "";
    area.dispatchEvent(new Event("change", { bubbles: true }));
    expect(s.setAutopilotFilters).toHaveBeenLastCalledWith({ edition: "core", area: undefined });
    s.autopilot.routines.routines = [];
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.querySelector<HTMLSelectElement>('select[aria-label="Area"]')!.value).toBe(
      "historical-area",
    );
  });
  it("localizes filter labels and allows all-edition/all-area defaults", () => {
    setLocale("ja");
    const s = state();
    s.locale = "ja";
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.querySelector<HTMLSelectElement>('select[aria-label="エディション"]')!.value).toBe(
      "",
    );
    expect(box.querySelector<HTMLSelectElement>('select[aria-label="分野"]')!.value).toBe("");
    expect(box.textContent).toContain("全分野");
    expect(box.textContent).toContain("プロジェクト合計は全エディション・全分野を含みます");
  });
  it("renders latest run status and exact server counts", () => {
    const s = state();
    s.autopilot.runs.runs.push({
      id: "run-1",
      projectId: "p1",
      routineId: "receipt",
      edition: "business",
      area: "finance",
      level: "L1",
      trigger: "manual",
      triggeredBy: "owner",
      startedAt: "2026-10-25T00:00:00Z",
      endedAt: "2026-10-25T00:01:00Z",
      status: "escalated",
      reason: "Missing citation",
      routineDigest: "d",
      reasoning: { backend: null, model: null, ms: 100, outputSha256: null },
      counts: {
        items: 4,
        prepared: 2,
        acted: 0,
        escalated: 1,
        refused: 1,
        failed: 0,
        handled: 2,
        deferred: 1,
      },
      workItems: [],
      evidence: null,
    });
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain("Receipt review · Escalated · L1 · Prepare");
    expect(box.textContent).toContain("Missing citation");
    expect(box.textContent).not.toContain("2026-10-25T00:00:00Z");
    expect(box.textContent).toContain(
      new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "long" }).format(
        new Date("2026-10-25T00:00:00Z"),
      ),
    );
    expect(box.textContent).toContain("Refused1");
    expect(box.textContent).toContain("Showing 1 of 4 runs");
    [...box.querySelectorAll("button")]
      .find((button) => button.textContent === "Inspect run evidence")!
      .click();
    expect(s.inspectAutopilotRun).toHaveBeenCalledWith("run-1");
    s.autopilot.selectedRunId = "run-1";
    s.autopilot.runDetail = {
      run: {
        ...s.autopilot.runs.runs[0],
        status: "ok",
        gather: [],
        actions: [
          {
            item: "receipt-1",
            kind: "draft",
            class: "prepare",
            decision: "allow",
            code: null,
            executed: false,
            error: null,
            approvalId: null,
            ref: "draft-1",
          },
        ],
      },
      evidence: { ok: false, problems: ["Missing bundle <script>bad()</script>"] },
    };
    render(renderAutopilot(s, { id: "p1" }), box);
    const selectedButton = box.querySelector('[aria-expanded="true"]')!;
    expect(selectedButton.getAttribute("aria-controls")).toBe("autopilot-run-details");
    expect(box.querySelector("#autopilot-run-details")).not.toBeNull();
    expect(box.textContent).toContain("Evidence has not passed verification");
    expect(box.textContent).not.toContain("Server evidence verification passed");
    expect(box.textContent).toContain("Missing bundle <script>bad()</script>");
    expect(box.querySelector("script")).toBeNull();
    expect(box.textContent).toContain("No evidence bundle recorded");
    expect(box.textContent).toContain("Decision: Allowed · Not executed");
    s.autopilot.runDetail.evidence = { ok: true, problems: ["Still invalid"] };
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).not.toContain("Server evidence verification passed");
    s.autopilot.runDetail.evidence = { ok: true, problems: [] };
    s.autopilot.runDetail.run.evidence = {
      bundle: "/private/evidence/bundle.json",
      root: "/private/evidence",
    };
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain("Evidence bundle recorded");
    expect(box.textContent).not.toContain("/private/evidence");
    expect(box.textContent).toContain("Server evidence verification passed");
    s.autopilot.runDetail.evidence = {
      ok: false,
      problems: Array.from({ length: 51 }, (_, i) => `Problem-${i}`),
    };
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.querySelectorAll("#autopilot-run-details li")).toHaveLength(50);
    expect(box.textContent).toContain("Showing the first 50 entries in this section");
    expect(box.textContent).not.toContain("Problem-50");
    s.autopilot.runDetail.evidence = { ok: true, problems: [] };
    s.locale = "ja";
    setLocale("ja");
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain("サーバーによる証跡の検証に合格しました");
    expect(box.textContent).toContain("判定: 許可 · 未実行");
    [...box.querySelectorAll("button")]
      .find((button) => button.textContent === "詳細を閉じる")!
      .click();
    expect(s.closeAutopilotRun).toHaveBeenCalledOnce();
  });
  it.each(["en", "ja"])("distinguishes retention receipts from live evidence in %s", (locale) => {
    const s = state();
    s.locale = locale;
    setLocale(locale);
    s.autopilot.selectedRunId = "r1";
    const retained =
      locale === "en"
        ? "Evidence removed; signed record kept."
        : "証跡が削除され、署名付き記録が保持されています。";
    const passed =
      locale === "en"
        ? "Server evidence verification passed."
        : "サーバーによる証跡の検証に合格しました。";
    const failed =
      locale === "en" ? "Evidence has not passed verification." : "証跡は検証に合格していません。";
    const recorded =
      locale === "en" ? "Evidence bundle recorded." : "証跡バンドルが記録されています。";
    const absent =
      locale === "en" ? "No evidence bundle recorded." : "証跡バンドルの記録はありません。";
    const draw = () => render(renderAutopilot(s, { id: "p1" }), box);
    draw();
    expect(box.textContent).not.toContain(retained);
    expect(box.textContent).not.toContain(passed);
    s.autopilot.runDetail = {
      run: {
        id: "r1",
        projectId: "p1",
        routineId: "receipt",
        edition: "business",
        area: "finance",
        level: "L1",
        trigger: "manual",
        triggeredBy: "owner",
        startedAt: "2026-10-25T00:00:00Z",
        endedAt: "2026-10-25T00:01:00Z",
        status: "ok",
        reason: null,
        routineDigest: "d",
        reasoning: { backend: null, model: null, ms: 10, outputSha256: null },
        counts: {
          items: 0,
          prepared: 0,
          acted: 0,
          escalated: 0,
          refused: 0,
          failed: 0,
          handled: 0,
          deferred: 0,
        },
        workItems: [],
        gather: [],
        actions: [],
        evidence: { bundle: "/private/removed/bundle.json", root: "signed-root" },
      },
      evidence: { ok: true, problems: [], tombstone: true },
    };
    draw();
    expect(box.textContent).toContain(retained);
    expect(box.textContent).not.toContain(passed);
    expect(box.textContent).not.toContain(recorded);
    expect(box.textContent).not.toContain(absent);
    for (const evidence of [
      { ok: false, problems: [], tombstone: true },
      { ok: false, problems: ["Invalid signature /private/removed"], tombstone: true },
      { ok: true, problems: ["Wrong run /private/removed"], tombstone: true },
    ]) {
      s.autopilot.runDetail.evidence = evidence;
      draw();
      expect(box.textContent).toContain(failed);
      expect(box.textContent).not.toContain(retained);
      expect(box.textContent).not.toContain(passed);
      expect(box.textContent).not.toContain(recorded);
      expect(box.textContent).not.toContain("/private/removed");
    }
    for (const tombstone of [undefined, false]) {
      s.autopilot.runDetail.evidence = { ok: true, problems: [], tombstone };
      draw();
      expect(box.textContent).toContain(passed);
      expect(box.textContent).toContain(recorded);
      expect(box.textContent).not.toContain(retained);
    }
    s.autopilot.runDetail.evidence = { ok: true, problems: [], tombstone: true };
    s.autopilot.runLoading = true;
    draw();
    expect(box.textContent).not.toContain(retained);
    s.autopilot.runLoading = false;
    s.autopilot.runError = true;
    draw();
    expect(box.textContent).not.toContain(retained);
  });
  it("renders detail loading and errors with close and retry controls", () => {
    const s = state();
    s.autopilot.selectedRunId = "r1";
    s.autopilot.runLoading = true;
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain("Loading run evidence");
    s.autopilot.runLoading = false;
    s.autopilot.runError = true;
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.querySelector('[role="alert"]')?.textContent).toContain(
      "Run evidence could not be loaded",
    );
    [...box.querySelectorAll("button")]
      .find((button) => button.textContent === "Retry evidence")!
      .click();
    expect(s.inspectAutopilotRun).toHaveBeenCalledWith("r1");
    s.connected = false;
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).not.toContain("Run details");
  });
  it("pages with the opaque server cursor and returns to latest", () => {
    const s = state();
    s.autopilot.runs.nextCursor = "opaque-next";
    render(renderAutopilot(s, { id: "p1" }), box);
    Array.from(box.querySelectorAll("button"))
      .find((b) => b.textContent === "Older runs")!
      .click();
    expect(s.refreshAutopilot).toHaveBeenCalledWith("opaque-next");
    s.autopilot.cursor = "opaque-next";
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain("Run history");
    expect(box.textContent).toContain("This page: 0 runs · 4 total");
    expect(box.textContent).not.toContain("Older runs");
    Array.from(box.querySelectorAll("button"))
      .find((b) => b.textContent === "Back to latest")!
      .click();
    expect(s.refreshAutopilot).toHaveBeenLastCalledWith();
  });
  it("falls back for unknown counters and invalid timestamps", () => {
    const s = state();
    s.autopilot.stats.totals = {
      ...s.autopilot.stats.totals,
      futureCounter: 7,
    } as typeof s.autopilot.stats.totals;
    s.autopilot.routines.routines = [
      { ...routine, state: { ...routine.state, lastRunAt: "invalid" } },
    ];
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain("futureCounter7");
    expect(box.textContent).not.toContain("autopilot.futureCounter");
    expect(box.textContent).not.toContain("Invalid Date");
  });
  it("hides old content while disconnected or on another project", () => {
    const s = state();
    s.connected = false;
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain("Disconnected");
    expect(box.textContent).not.toContain("Receipt review");
    s.connected = true;
    render(renderAutopilot(s, { id: "p2" }), box);
    expect(box.textContent).toContain("Loading Autopilot");
    expect(box.textContent).not.toContain("Receipt review");
  });
  it("renders invalid and absent policy without routine controls", () => {
    const s = state();
    s.autopilot.routines.error = "bad policy";
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain("Autopilot policy is invalid");
    expect(box.textContent).not.toContain("Receipt review");
    s.autopilot.routines.error = null;
    s.autopilot.routines.source.kind = "none";
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain("No Autopilot policy configured");
  });
  it("uses the Japanese catalogue and localized routine names", () => {
    setLocale("ja");
    const s = state();
    s.locale = "ja";
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain("オートパイロット");
    expect(box.textContent).toContain("領収書確認");
    expect(box.textContent).toContain("不明");
    s.autopilot.routines.routines = [
      { ...routine, state: { ...routine.state, lastRunAt: "2026-10-25T00:00:00Z" } },
    ];
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.textContent).toContain(
      new Intl.DateTimeFormat("ja", { dateStyle: "medium", timeStyle: "long" }).format(
        new Date("2026-10-25T00:00:00Z"),
      ),
    );
  });
});

describe("routine controls", () => {
  it.each(["stopped", "emergencyStop"] as const)(
    "hides resume while %s alone is active",
    (flag) => {
      const s = state();
      s.canDeclineAutonomy = true;
      s.autopilot.routines.control = {
        ...s.autopilot.routines.control,
        stopped: false,
        emergencyStop: false,
        [flag]: true,
      };
      render(renderAutopilot(s, { id: "p1" }), box);
      expect(box.querySelector("[data-routine-id] form")).toBeNull();
      expect(box.textContent).toContain("All routines are stopped");
      expect(s.changeAutopilotRoutine).not.toHaveBeenCalled();
    },
  );
  it("shows only resume for paused routines, enforces watchdog reason and locks with declines", () => {
    const s = state();
    s.canDeclineAutonomy = true;
    s.autopilot.routines.routines = [
      { ...routine, state: { ...routine.state, pausedBy: "watchdog" } },
    ];
    render(renderAutopilot(s, { id: "p1" }), box);
    const button = () => box.querySelector<HTMLButtonElement>("[data-routine-id] button")!;
    expect(button().textContent).toBe("Resume routine");
    expect(button().disabled).toBe(true);
    const input = box.querySelector<HTMLTextAreaElement>("[data-routine-id] textarea")!;
    expect(input.minLength).toBe(4);
    input.value = "Reviewed";
    input.dispatchEvent(new Event("input"));
    expect(s.setAutopilotRoutineReason).toHaveBeenCalledWith("receipt", "Reviewed");
    s.autopilot.routineReasons.receipt = "Reviewed";
    render(renderAutopilot(s, { id: "p1" }), box);
    box
      .querySelector("[data-routine-id] form")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    expect(s.changeAutopilotRoutine).toHaveBeenCalledWith("receipt", "resume");
    s.autopilot.declinePending = "other";
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(button().disabled).toBe(true);
    s.autopilot.routines.control.stopped = true;
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(button()).toBeNull();
    expect(box.textContent).toContain("All routines are stopped");
  });
  it("shows pause in Japanese only for active routines with approval permission", () => {
    const s = state();
    s.autopilot.routines.routines = [{ ...routine, state: { ...routine.state, paused: false } }];
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.querySelector("[data-routine-id] form")).toBeNull();
    s.canDeclineAutonomy = true;
    setLocale("ja");
    render(renderAutopilot(s, { id: "p1" }), box);
    expect(box.querySelector("[data-routine-id] button")!.textContent).toBe("ルーチンを一時停止");
  });
});

it.each(["en", "ja"])(
  "offers bounded, person-only reports for the inspected run in %s",
  (locale) => {
    const s = state();
    s.locale = locale;
    setLocale(locale);
    s.canDeclineAutonomy = true;
    s.autopilot.selectedRunId = "r1";
    s.autopilot.runDetail = {
      run: {
        id: "r1",
        projectId: "p1",
        routineId: "receipt",
        edition: "business",
        area: "finance",
        level: "L1",
        trigger: "manual",
        triggeredBy: "owner",
        startedAt: "2026-10-25T00:00:00Z",
        endedAt: "2026-10-25T00:01:00Z",
        status: "ok",
        reason: null,
        routineDigest: "d",
        reasoning: { backend: null, model: null, ms: 10, outputSha256: null },
        counts: {
          items: 1,
          prepared: 1,
          acted: 0,
          escalated: 0,
          refused: 0,
          failed: 0,
          handled: 1,
          deferred: 0,
        },
        workItems: ["item1"],
        evidence: null,
        gather: [],
        actions: [],
      },
      evidence: { ok: true, problems: [] },
    };
    const draw = () => render(renderAutopilot(s, { id: "p1" }), box);
    draw();
    const form = () => box.querySelector<HTMLFormElement>("[data-report-error]")!;
    const button = () => form().querySelector<HTMLButtonElement>("button")!;
    expect(button().textContent).toBe(
      locale === "en" ? "Report a serious error" : "重大な誤りを報告",
    );
    expect(form().textContent).toContain("L0");
    expect(button().disabled).toBe(true);
    const input = form().querySelector("textarea")!;
    input.value = "Wrong recipient";
    input.dispatchEvent(new Event("input"));
    expect(s.setAutopilotReportReason).toHaveBeenCalledWith("item1", "Wrong recipient");
    s.autopilot.reportReasons.item1 = "Wrong recipient";
    draw();
    expect(button().disabled).toBe(false);
    form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(s.reportAutopilotError).toHaveBeenCalledExactlyOnceWith("item1");
    for (const pending of [
      "reportPending",
      "acceptPending",
      "declinePending",
      "routinePending",
    ] as const) {
      s.autopilot[pending] = "other";
      draw();
      expect(button().disabled).toBe(true);
      expect(form().querySelector("textarea")!.disabled).toBe(true);
      s.autopilot[pending] = null;
    }
    s.connected = false;
    draw();
    expect(form()).toBeNull();
    s.connected = true;
    document.body.append(box);
    try {
      for (const width of [280, 390]) {
        box.style.width = `${width}px`;
        draw();
        expect(form().scrollWidth).toBeLessThanOrEqual(width);
      }
    } finally {
      box.remove();
      box.style.width = "";
    }
    s.canDeclineAutonomy = false;
    draw();
    expect(form()).toBeNull();
    s.canDeclineAutonomy = true;
    render(renderAutopilot(s, { id: "p2" }), box);
    expect(form()).toBeNull();
    s.autopilot.runDetail.run.workItems = Array.from({ length: 51 }, (_, i) => `item${i}`);
    draw();
    expect(box.querySelectorAll("[data-report-error]")).toHaveLength(50);
  },
);
