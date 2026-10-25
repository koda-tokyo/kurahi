// The Industrial starter routine (nightly-legacy-analysis) end to end through the engine, with a
// fake reasoner and the real legacy-analyzer plugin tools: the first run only creates the
// baseline, an unchanged night files nothing (no model call), a change files one work item with
// a non-empty summary that references the 設計書 docx, and the baseline then moves forward.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KoLoPluginApi, KoLoPluginToolContext } from "../plugins/types.js";
import type { Project } from "../projects/types.js";
import type { Reasoner } from "./reasoner.js";
import type { ToolCall, ToolInvoker } from "./runner.js";
import register from "../../extensions/legacy-analyzer/index.js";
import { A, B, program } from "../../packages/legacy-analyzer/src/test-fixtures/helpers.js";
import { flushAudit } from "../audit/audit-log.js";
import { createProject } from "../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../projects/templates.js";
import { readWorkItem } from "../workitems/store.js";
import { cleanActionArgs, getActionDef } from "./actions.js";
import { authorizeAction } from "./authorize.js";
import { runRoutine } from "./runner.js";
import { gatherToolRefusal } from "./tools.js";
import { defaultWorkItemSink } from "./workitems-adapter.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autopilot-legacy-")));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

type Tool = {
  name: string;
  execute: (
    id: string,
    p: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>;
};
let factory: ((ctx: KoLoPluginToolContext) => unknown) | null = null;
register({
  paths: { stateDir: path.join(root, "state") },
  registerTool: (f: (ctx: KoLoPluginToolContext) => unknown) => {
    factory = f;
  },
} as unknown as KoLoPluginApi);

let project: Project;
let calls: ToolCall[] = [];
/** The gateway tool path, reduced: the analyser plugin's own tools in the Project session. */
const tools: ToolInvoker = async (call) => {
  calls.push(call);
  const list = factory!({ workspaceDir: project.folder, sessionKey: call.sessionKey }) as Tool[];
  const tool = list.find((t) => t.name === call.tool);
  if (!tool) {
    return { ok: false, error: `unexpected tool ${call.tool}` };
  }
  const res = await tool.execute("t", call.args);
  if (res.details?.ok === false) {
    return { ok: false, error: res.content[0]?.text ?? "failed" };
  }
  return {
    ok: true,
    text: res.content.map((c) => c.text).join("\n"),
    details: res.details,
    pluginId: "legacy-analyzer",
  };
};

let reasonCalls = 0;
let lastPrompt = "";
const reasoner: Reasoner = {
  async reason(req) {
    reasonCalls++;
    lastPrompt = req.prompt;
    return { text: JSON.stringify({ items: [] }), backend: "fake", model: null };
  },
};
const deps = () => ({
  cfg: {},
  reasoner,
  tools,
  workItems: defaultWorkItemSink(),
  defaultAgentId: "main",
});
const manual = { kind: "manual" as const, by: "device:person" };
const ROUTINE = "nightly-legacy-analysis";

const CALC = (extra: string[] = []) =>
  program("ORDCALC", {
    proc: [
      A("0000-MAIN."),
      B("PERFORM 1000-PRICE"),
      B("STOP RUN."),
      A("1000-PRICE."),
      ...extra,
      B("GOBACK."),
    ],
  });
const writeSource = (rel: string, text: string) => {
  const abs = path.join(project.folder, "source", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${text}\n`);
};

beforeAll(() => {
  const folder = path.join(root, "proj");
  fs.mkdirSync(path.join(folder, "source", "cobol"), { recursive: true });
  fs.writeFileSync(path.join(folder, "source", "cobol", "ORDCALC.cbl"), `${CALC()}\n`);
  const template = loadTemplates(resolveTemplatesDir({})).find(
    (t) => t.id === "industry-legacy-modernisation",
  )!;
  project = createProject(
    { name: "Legacy", folder, allowedAgents: [] },
    { createdBy: "device:admin", template },
  );
});

beforeEach(() => {
  calls = [];
  reasonCalls = 0;
});

afterAll(async () => {
  await flushAudit();
  process.env.KOLO_HOME = saved.home;
  process.env.KOLO_STATE_DIR = saved.state;
  if (saved.home === undefined) {
    delete process.env.KOLO_HOME;
  }
  if (saved.state === undefined) {
    delete process.env.KOLO_STATE_DIR;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function planFromPrompt(): unknown {
  // What a model does with the legacy_changes source: one item, three actions.
  const digest = /"current": \{\s*"digest": "([a-f0-9]{16})"/.exec(lastPrompt)?.[1];
  return {
    items: [
      {
        ref: `legacy-changes:${digest}`,
        title: "ORDNEW を追加、ORDCALC から CALL",
        summary:
          "変更点: program ORDNEW added (cobol/ORDNEW.cbl:1); CALL ORDCALC→ORDNEW added (cobol/ORDCALC.cbl:9)\n影響: ORDCALC の呼出し先が増加\n確認: ORDNEW の業務目的を確認",
        priority: "normal",
        sources: ["changes"],
        actions: [
          {
            kind: "legacy.design_doc",
            args: { path: "source", lang: "ja", output_format: "docx" },
          },
          {
            kind: "workitem.intake",
            args: { title: "ORDNEW を追加", note: "ORDNEW の業務目的を確認" },
          },
          { kind: "legacy.baseline_advance", args: { path: "source", snapshot: digest } },
        ],
      },
    ],
  };
}

describe("nightly-legacy-analysis through the engine", () => {
  it("first run creates the baseline: no_input, no model call, no item", async () => {
    const run = await runRoutine(deps(), project, ROUTINE, manual);
    expect(run.status).toBe("no_input");
    expect(run.reason).toMatch(/baseline created/);
    expect(reasonCalls).toBe(0);
    expect(run.workItems).toEqual([]);
    // The gate stopped the gather: the wave plan was not computed.
    expect(calls.map((c) => c.tool)).toEqual(["legacy_changes"]);
  });

  it("an unchanged night files nothing", async () => {
    const run = await runRoutine(deps(), project, ROUTINE, manual);
    expect(run.status).toBe("no_input");
    expect(run.reason).toBe("no change since the baseline");
    expect(reasonCalls).toBe(0);
    expect(run.workItems).toEqual([]);
  });

  it("a change files one item with a summary and the docx, then advances the baseline", async () => {
    writeSource("cobol/ORDCALC.cbl", CALC([B("CALL 'ORDNEW'")]));
    writeSource("cobol/ORDNEW.cbl", program("ORDNEW", { proc: [A("0000-MAIN."), B("GOBACK.")] }));
    const fakeReasoner: Reasoner = {
      async reason(req) {
        reasonCalls++;
        lastPrompt = req.prompt;
        return { text: JSON.stringify(planFromPrompt()), backend: "fake", model: null };
      },
    };
    const run = await runRoutine({ ...deps(), reasoner: fakeReasoner }, project, ROUTINE, manual);
    expect(lastPrompt).toContain("SOURCE changes (legacy_changes)");
    expect(lastPrompt).toContain('"status": "changed"');
    expect(run.status).toBe("ok");
    expect(run.workItems).toHaveLength(1);
    // Order: design doc, intake, then the baseline advance after the filing.
    expect(calls.map((c) => c.tool)).toEqual([
      "legacy_changes",
      "legacy_wave_plan",
      "legacy_design_doc",
      "legacy_baseline_advance",
    ]);
    const item = readWorkItem(project.id, run.workItems[0])!;
    expect(item.summary).toContain("ORDNEW added (cobol/ORDNEW.cbl:1)");
    expect(item.queue).toBe("ind-analysis");
    const doc = item.source.documents[0];
    expect(doc).toMatchObject({ kind: "file" });
    expect(doc.ref).toMatch(/^output\/design-docs\/設計書_\d{8}(-\d+)?\.docx$/);
    expect(fs.existsSync(path.join(project.folder, doc.ref))).toBe(true);
    expect(item.source.fields.autopilotDocuments).toBe(doc.ref);
    // The next night compares against tonight: nothing new.
    const next = await runRoutine(deps(), project, ROUTINE, manual);
    expect(next.status).toBe("no_input");
    expect(next.reason).toBe("no change since the baseline");
  });

  it("does not advance the baseline when no work item was filed", async () => {
    writeSource("cobol/ORDLATE.cbl", program("ORDLATE", { proc: [A("0000-MAIN."), B("GOBACK.")] }));
    const noIntake: Reasoner = {
      async reason(req) {
        lastPrompt = req.prompt;
        const plan = planFromPrompt() as { items: Array<{ actions: Array<{ kind: string }> }> };
        plan.items[0].actions = plan.items[0].actions.filter(
          (a) => a.kind === "legacy.baseline_advance",
        );
        return { text: JSON.stringify(plan), backend: "fake", model: null };
      },
    };
    const run = await runRoutine({ ...deps(), reasoner: noIntake }, project, ROUTINE, manual);
    expect(run.workItems).toEqual([]);
    expect(calls.map((c) => c.tool)).not.toContain("legacy_baseline_advance");
    // Still reported the next night.
    const again = await runRoutine(deps(), project, ROUTINE, manual);
    expect(again.status).not.toBe("no_input");
  });
  it("a deferred action holds its daily budget: the intake is filed, the baseline waits", async () => {
    const policy = fs
      .readFileSync(
        path.join(
          resolveTemplatesDir({}),
          "packs",
          "industry-legacy-modernisation",
          "autopilot.yaml",
        ),
        "utf8",
      )
      .replace("maxActionsPerDay: 20", "maxActionsPerDay: 1");
    fs.mkdirSync(path.join(project.folder, "context"), { recursive: true });
    fs.writeFileSync(path.join(project.folder, "context", "autopilot.yaml"), policy);
    await runRoutine(deps(), project, ROUTINE, manual);
    writeSource("cobol/ORDNEW.cbl", program("ORDNEW", { proc: [A("0000-MAIN."), B("GOBACK.")] }));
    const reasoner: Reasoner = {
      async reason(req) {
        lastPrompt = req.prompt;
        const plan = planFromPrompt() as { items: Array<{ actions: Array<{ kind: string }> }> };
        // The baseline first: the intake still wins the one remaining action.
        plan.items[0].actions = plan.items[0].actions
          .filter((a) => a.kind !== "legacy.design_doc")
          .toSorted((a, b) =>
            a.kind === "legacy.baseline_advance"
              ? -1
              : b.kind === "legacy.baseline_advance"
                ? 1
                : 0,
          );
        return { text: JSON.stringify(plan), backend: "fake", model: null };
      },
    };
    const run = await runRoutine({ ...deps(), reasoner }, project, ROUTINE, manual);
    expect(run.workItems).toHaveLength(1);
    expect(calls.map((c) => c.tool)).not.toContain("legacy_baseline_advance");
    const baseline = run.actions.find((o) => o.kind === "legacy.baseline_advance");
    expect(baseline).toMatchObject({
      decision: "needs_person",
      code: "daily_limit",
      executed: false,
    });
  });
});

describe("autopilot work item summary", () => {
  const routine = {
    id: "nightly-legacy-analysis",
    edition: "industrial",
    area: "analysis",
    queue: "ind-analysis",
  } as unknown as import("./types.js").Routine;
  const item = (summary: string) => ({
    ref: "legacy-changes:x",
    title: "変更あり",
    summary,
    category: null,
    priority: "normal" as const,
    flags: [],
    sources: [],
    actions: [],
  });
  const file = (summary: string, note?: string) =>
    readWorkItem(
      project.id,
      defaultWorkItemSink().create({
        project,
        routine,
        runId: "run-1",
        item: item(summary),
        kind: "intake",
        note,
        awaitingPerson: null,
        pending: [],
      }).id,
    )!;

  it("puts the plan summary on the item itself (it used to reach only source.fields)", () => {
    const filed = file("変更点: ORDNEW added (cobol/ORDNEW.cbl:1)");
    expect(filed.summary).toBe("変更点: ORDNEW added (cobol/ORDNEW.cbl:1)");
    expect(filed.source.fields.summary).toBe(filed.summary);
  });

  it("falls back to the intake note when the plan summary is empty", () => {
    const filed = file("  ", "ORDNEW の業務目的を確認");
    expect(filed.summary).toBe("ORDNEW の業務目的を確認");
    expect(filed.source.fields.note).toBe("ORDNEW の業務目的を確認");
  });
});

describe("legacy.baseline_advance action guards", () => {
  const def = getActionDef("legacy.baseline_advance")!;
  const routine = {
    id: "r",
    edition: "industrial" as const,
    level: "L1" as const,
    actions: ["legacy.baseline_advance"],
    limits: { maxItemsPerRun: 5, maxActionsPerDay: 20 },
  };
  const ctx = { now: new Date(), flags: [], approvals: [], actionsToday: 0, approvalUsesToday: {} };

  it("is an Industrial prepare action that runs after the intake", () => {
    expect(def).toMatchObject({ class: "prepare", editions: ["industrial"], afterIntake: true });
    expect(def.tools).toEqual(["legacy_baseline_advance"]);
    expect(authorizeAction(routine, { kind: def.id, args: { path: "source" } }, ctx).decision).toBe(
      "allow",
    );
  });

  it("is refused outside the Industrial edition and with bad arguments", () => {
    const business = { ...routine, edition: "business" as const };
    expect(
      authorizeAction(business, { kind: def.id, args: { path: "source" } }, ctx).decision,
    ).toBe("refuse");
    expect(cleanActionArgs(def, {}).ok).toBe(false);
    expect(cleanActionArgs(def, { path: "source", rebuild: true }).ok).toBe(false);
    expect(cleanActionArgs(def, { path: "source", snapshot: "xyz" }).ok).toBe(false);
    expect(cleanActionArgs(def, { path: "source", snapshot: "0123456789abcdef" }).ok).toBe(true);
  });

  it("legacy_changes may gather; the advance tool may not", () => {
    expect(gatherToolRefusal("legacy_changes")).toBeNull();
    expect(gatherToolRefusal("legacy_baseline_advance")).toMatch(/write tool/);
  });

  it("legacy.design_doc accepts output_format md or docx only", () => {
    const doc = getActionDef("legacy.design_doc")!;
    expect(cleanActionArgs(doc, { path: "source", output_format: "docx" }).ok).toBe(true);
    expect(cleanActionArgs(doc, { path: "source", output_format: "pdf" }).ok).toBe(false);
  });
});
