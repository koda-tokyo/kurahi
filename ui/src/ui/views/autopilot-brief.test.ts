import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { AutopilotBrief } from "../controllers/autopilot";
import { emptyAutopilot } from "../controllers/autopilot";
import { setLocale } from "../i18n";
import { renderAutopilotBrief } from "./autopilot-brief";

const now = Date.parse("2026-10-25T04:00:00Z");
const fixture = (): AutopilotBrief => ({
  version: 1,
  projectId: "p1",
  projectName: "Example",
  principal: "person:alice",
  name: "Alice",
  generatedAt: "2026-10-25T04:00:00Z",
  window: { from: "2026-10-24T04:00:00Z", to: "2026-10-25T04:00:00Z" },
  handled: {
    runs: 0,
    items: 0,
    prepared: 0,
    acted: 0,
    escalated: 0,
    handled: 0,
    failedRuns: 0,
    drafts: 0,
    areas: [],
  },
  documents: [],
  waiting: { decisions: [], flagged: [], proposals: [] },
  commitments: [],
  problems: {
    watchdog: [],
    runs: [],
    demotions: [],
    paused: [],
    routinesError: null,
    control: { stopped: false, emergencyStop: false },
  },
});
const box = document.createElement("div");
afterEach(() => {
  render(null, box);
  setLocale("en");
});
describe("caller morning brief", () => {
  it.each(["en", "ja"])("renders empty, populated, stale and failed snapshots in %s", (locale) => {
    setLocale(locale);
    const state = { ...emptyAutopilot(), projectId: "p1", brief: fixture() };
    const draw = () => render(renderAutopilotBrief(state, "p1", true, locale, now), box);
    draw();
    expect(box.textContent).toContain(
      locale === "en" ? "Your morning brief" : "あなたの朝のブリーフ",
    );
    expect(box.textContent).toContain(locale === "en" ? "None" : "なし");
    expect(box.textContent).not.toContain("autopilot.");
    state.brief.waiting.decisions.push({
      projectId: "p1",
      itemId: "i1",
      title: "<script>private decision</script>",
      queue: "finance",
      status: "review",
      priority: "high",
      dueAt: "2026-10-24T01:00:00Z",
      overdue: true,
    });
    state.brief.problems.paused.push({
      routineId: "receipt",
      pausedBy: "watchdog",
      pausedAt: null,
      reason: "Review limit",
    });
    state.brief.documents.push({
      runId: "run1",
      routineId: "receipt",
      path: "javascript:alert(1)",
      at: state.brief.generatedAt,
    });
    state.brief.generatedAt = "2026-10-24T04:00:00Z";
    draw();
    expect(box.textContent).toContain("private decision");
    expect(box.querySelector("script, a")).toBeNull();
    expect(box.textContent).toContain(locale === "en" ? "Overdue" : "期限超過");
    expect(box.textContent).toContain(locale === "en" ? "over an hour old" : "1時間以上前");
    expect(box.textContent).not.toContain("Review limit");
    state.briefError = true;
    draw();
    expect(box.textContent).toContain(locale === "en" ? "unavailable" : "取得できません");
    expect(box.textContent).not.toContain("private decision");
  });
  it("hides snapshots during loading, offline and project changes", () => {
    const state = { ...emptyAutopilot(), projectId: "p1", brief: fixture() };
    state.brief.documents.push({
      runId: "r1",
      routineId: "r",
      path: "private-document",
      at: state.brief.generatedAt,
    });
    for (const [project, connected, loading] of [
      ["p2", true, false],
      ["p1", false, false],
      ["p1", true, true],
    ] as const) {
      state.loading = loading;
      render(renderAutopilotBrief(state, project, connected, "en", now), box);
      expect(box.textContent).not.toContain("private-document");
    }
  });
  it.each([50, 51])("discloses the server or display cap at %i entries", (count) => {
    const brief = fixture();
    brief.documents = Array.from({ length: count }, (_, i) => ({
      path: `document-${i}`,
      at: brief.generatedAt,
      runId: "r1",
      routineId: "r",
    }));
    render(
      renderAutopilotBrief({ ...emptyAutopilot(), projectId: "p1", brief }, "p1", true, "en", now),
      box,
    );
    expect(box.textContent).toContain("document-49");
    expect(box.textContent).not.toContain("document-50");
    expect(box.textContent).toContain(
      count === 50 ? "More may be available" : "Some entries are omitted",
    );
  });
});

it("does not render raw internal error text", () => {
  const brief = fixture();
  brief.problems.routinesError = "secret-config-path";
  brief.problems.runs.push({
    routineId: "r",
    runId: "r1",
    at: brief.generatedAt,
    status: "failed",
    reason: "secret-config-path",
  });
  render(
    renderAutopilotBrief({ ...emptyAutopilot(), projectId: "p1", brief }, "p1", true, "en", now),
    box,
  );
  expect(box.textContent).not.toContain("secret-config-path");
  expect(box.textContent).toContain("Failed");
});

it.each(["en", "ja"])("bounds and escapes flagged diagnostics in %s", (locale) => {
  setLocale(locale);
  const brief = fixture();
  const hostile = '<img src=x onerror="alert(1)">';
  brief.waiting.flagged.push({
    projectId: "p1",
    itemId: "flagged",
    title: "Flagged",
    queue: "finance",
    status: "review",
    priority: "high",
    dueAt: null,
    overdue: false,
    flags: [
      hostile,
      "x".repeat(5000) + "hidden-tail",
      ...Array.from({ length: 9 }, (_, i) => `flag-${i}`),
    ],
  });
  document.body.append(box);
  try {
    box.style.width = "280px";
    render(
      renderAutopilotBrief(
        { ...emptyAutopilot(), projectId: "p1", brief },
        "p1",
        true,
        locale,
        now,
      ),
      box,
    );
    const flags = box.querySelector("[data-brief-flags]")!;
    expect(flags.querySelectorAll("li")).toHaveLength(10);
    expect(flags.textContent).toContain(hostile);
    expect(flags.textContent).not.toContain("hidden-tail");
    expect(flags.textContent).not.toContain("flag-8");
    expect(flags.textContent.length).toBeLessThan(600);
    expect(flags.querySelector("img, script, a")).toBeNull();
    expect(flags.textContent).toContain(locale === "en" ? "text shortened" : "テキストを省略");
    expect(flags.textContent).toContain(locale === "en" ? "first 10 flags" : "最初の10件");
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    expect(box.textContent).not.toContain("autopilot.");
  } finally {
    box.remove();
    box.style.width = "";
  }
});

it.each(["en", "ja"])(
  "shows safe failed/skipped reason categories, never private suffixes in %s",
  (locale) => {
    setLocale(locale);
    const brief = fixture();
    const reasons = [
      "gather failed: secret-config-path <script>" + "x".repeat(5000),
      "kill switch: agent private-agent stopped by private-operator",
      "<img src=x onerror=alert(1)>secret-token",
      null,
    ];
    brief.problems.runs = reasons.map((reason, i) => ({
      routineId: "r",
      runId: `r${i}`,
      at: brief.generatedAt,
      status: i === 1 ? "skipped" : "failed",
      reason,
    }));
    render(
      renderAutopilotBrief(
        { ...emptyAutopilot(), projectId: "p1", brief },
        "p1",
        true,
        locale,
        now,
      ),
      box,
    );
    const rows = [...box.querySelectorAll("[data-brief-run-reason]")].map((el) => el.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain(locale === "en" ? "Input gathering failed" : "入力の収集に失敗");
    expect(rows[1]).toContain(locale === "en" ? "stop control" : "停止制御");
    expect(rows[2]).toContain(locale === "en" ? "diagnostic details are hidden" : "内部診断の詳細");
    expect(rows[3]).toContain(locale === "en" ? "No reason recorded" : "理由は記録されていません");
    expect(rows.join("").length).toBeLessThan(300);
    expect(box.textContent).not.toMatch(/secret-|private-agent|private-operator|onerror/);
    expect(box.querySelector("img, script")).toBeNull();
    expect(box.textContent).not.toContain("autopilot.");
  },
);

it.each([true, false, undefined])(
  "honors truncation metadata %s across the four capped lists",
  (truncated) => {
    const brief = fixture();
    if (truncated !== undefined) {
      brief.truncated = {
        documents: truncated,
        decisions: truncated,
        flagged: truncated,
        commitments: truncated,
      };
    }
    const item = {
      projectId: "p1",
      itemId: "i1",
      title: "Item",
      queue: "finance",
      status: "review" as const,
      priority: "high" as const,
      dueAt: null,
      overdue: false,
    };
    brief.documents = Array.from({ length: 50 }, () => ({
      path: "doc",
      routineId: "r",
      runId: "r1",
      at: brief.generatedAt,
    }));
    brief.waiting.decisions = Array.from({ length: 50 }, () => ({ ...item }));
    brief.waiting.flagged = Array.from({ length: 50 }, () => ({ ...item, flags: [] }));
    brief.commitments = Array.from({ length: 50 }, () => ({ ...item }));
    render(
      renderAutopilotBrief({ ...emptyAutopilot(), projectId: "p1", brief }, "p1", true, "en", now),
      box,
    );
    expect(box.querySelectorAll("[data-brief-limit]")).toHaveLength(truncated === false ? 0 : 4);
    if (truncated === true) {
      expect(box.textContent).toContain("Some entries are omitted");
    }
    if (truncated === undefined) {
      expect(box.textContent).toContain("More may be available");
    }
  },
);

it("discloses a local display cap even when the server reports no truncation", () => {
  const brief = fixture();
  brief.truncated = { documents: false, decisions: false, flagged: false, commitments: false };
  brief.documents = Array.from({ length: 51 }, (_, i) => ({
    path: `document-${i}`,
    routineId: "r",
    runId: "r1",
    at: brief.generatedAt,
  }));
  render(
    renderAutopilotBrief({ ...emptyAutopilot(), projectId: "p1", brief }, "p1", true, "en", now),
    box,
  );
  expect(box.textContent).toContain("Some entries are omitted");
  expect(box.textContent).not.toContain("document-50");
});
