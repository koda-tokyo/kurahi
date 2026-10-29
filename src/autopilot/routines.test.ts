import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { resolveTemplatesDir } from "../projects/templates.js";
import { loadRoutines, parseRoutines } from "./routines.js";

const BASE = {
  id: "r1",
  edition: "business",
  area: "secretariat",
  trigger: { schedule: "*/15 8-19 * * 1-5", tz: "Asia/Tokyo" },
  gather: [{ id: "inbox", tool: "m365_mail_list", args: { top: 5 } }],
  reasoning: { prompt: "mail-triage" },
  actions: ["workitem.intake", "mail.draft"],
  level: "L1",
};
const doc = (routine: Record<string, unknown>) =>
  YAML.stringify({ version: 1, routines: [routine] });
const bad = (over: Record<string, unknown>) => () => parseRoutines(doc({ ...BASE, ...over }));

describe("routine file validation (fail closed)", () => {
  it("parses a valid routine with defaults", () => {
    const [r] = parseRoutines(doc(BASE));
    expect(r).toMatchObject({
      id: "r1",
      edition: "business",
      area: "secretariat",
      level: "L1",
      enabled: true,
      limits: { maxItemsPerRun: 10, maxActionsPerDay: 200 },
      reasoning: { promptId: "mail-triage", schemaId: "autopilot.plan.v1", timeoutSeconds: 300 },
      requireCitations: false,
      baselineMinutes: null,
    });
  });

  it.each([
    ["unknown key", { extra: 1 }, /unknown key extra/],
    ["edition", { edition: "enterprise" }, /edition must be/],
    ["business area must be a department", { area: "literature" }, /area must be one of/],
    [
      "scholars area",
      { edition: "scholars", area: "finance", actions: ["workitem.intake"] },
      /area/,
    ],
    ["industrial area", { edition: "industrial", area: "secretariat" }, /area/],
    ["core area", { edition: "core", area: "ot-monitoring" }, /area/],
    ["interval below 5 minutes", { trigger: { interval: 2 } }, /interval/],
    ["schedule and interval", { trigger: { schedule: "* * * * *", interval: 10 } }, /not both/],
    ["bad cron", { trigger: { schedule: "every day" } }, /cron/],
    ["bad timezone", { trigger: { schedule: "0 9 * * *", tz: "Mars/Base" } }, /timezone/],
    ["write tool in gather", { gather: [{ tool: "m365_mail_send" }] }, /write tool/],
    ["draft tool in gather", { gather: [{ tool: "m365_mail_create_draft" }] }, /write tool/],
    ["exec in gather", { gather: [{ tool: "exec", args: { command: "rm -rf /" } }] }, /write tool/],
    ["undeclared tool", { gather: [{ tool: "some_plugin_tool" }] }, /not a declared read tool/],
    [
      "each from a later step",
      {
        gather: [{ id: "a", tool: "m365_mail_read", each: { from: "b", match: "(x)", arg: "id" } }],
      },
      /earlier step/,
    ],
    [
      "each without a group",
      {
        gather: [
          { id: "a", tool: "m365_mail_list" },
          { id: "b", tool: "m365_mail_read", each: { from: "a", match: "id: \\S+", arg: "id" } },
        ],
      },
      /capturing group/,
    ],
    ["unknown action", { actions: ["shell.exec"] }, /unknown action/],
    ["never action listed", { actions: ["payment.execute"] }, /never autonomous/],
    ["action of another edition", { actions: ["legacy.analyze"] }, /not available/],
    ["L0 with actions", { level: "L0" }, /observes only/],
    ["unknown level", { level: "L4" }, /level/],
    ["unknown prompt", { reasoning: { prompt: "whatever" } }, /prompt must be/],
    [
      "prompt and promptText",
      { reasoning: { prompt: "mail-triage", promptText: "x" } },
      /not both/,
    ],
    ["inline prompt over 8 KB", { reasoning: { promptText: "x".repeat(8193) } }, /8 KB/],
    ["unknown schema", { reasoning: { prompt: "mail-triage", schema: "free.form" } }, /schema/],
    [
      "actionTools outside the catalogue",
      { actionTools: { "mail.draft": "m365_mail_send" } },
      /must be one of/,
    ],
    ["limits out of range", { limits: { maxItemsPerRun: 0 } }, /maxItemsPerRun/],
    ["baseline out of range", { metrics: { baselineMinutes: -1 } }, /baselineMinutes/],
  ])("refuses %s", (_name, over, re) => {
    expect(bad(over)).toThrow(re);
  });

  it("refuses a reasoning backend the engine cannot run when the file is loaded", () => {
    expect(bad({ reasoning: { prompt: "mail-triage", backend: "gemini-cli" } })).toThrow(
      /unknown reasoning backend "gemini-cli"/,
    );
    expect(() =>
      parseRoutines(
        YAML.stringify({ version: 1, reasoner: { backend: "nope" }, routines: [BASE] }),
      ),
    ).toThrow(/unknown reasoning backend "nope"/);
  });

  it("requires <provider>/<model> for the api backend", () => {
    expect(bad({ reasoning: { prompt: "mail-triage", backend: "api" } })).toThrow(
      /needs a model "<provider>\/<model>"/,
    );
    expect(bad({ reasoning: { prompt: "mail-triage", backend: "api", model: "qwen" } })).toThrow(
      /needs a model/,
    );
    const [r] = parseRoutines(
      doc({
        ...BASE,
        reasoning: { prompt: "mail-triage", backend: "api", model: "ollama/qwen3:4b" },
      }),
    );
    expect(r.reasoning).toMatchObject({ backend: "api", model: "ollama/qwen3:4b" });
  });

  it("refuses duplicate ids", () => {
    expect(() => parseRoutines(YAML.stringify({ routines: [BASE, BASE] }))).toThrow(/twice/);
  });

  it("accepts an inline prompt up to 8 KB and scholars require citations by default", () => {
    const [r] = parseRoutines(
      doc({
        ...BASE,
        edition: "scholars",
        area: "literature",
        gather: [{ tool: "web_search", args: { query: "q" } }],
        actions: ["workitem.intake", "research.search"],
        reasoning: { promptText: "x".repeat(8192) },
      }),
    );
    expect(r.requireCitations).toBe(true);
    expect(r.reasoning.promptId).toBeNull();
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autopilot-routines-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("one invalid routine disables the whole file", () => {
    const folder = path.join(root, "p1");
    fs.mkdirSync(path.join(folder, "context"), { recursive: true });
    fs.writeFileSync(
      path.join(folder, "context", "autopilot.yaml"),
      YAML.stringify({
        routines: [BASE, { ...BASE, id: "r2", gather: [{ tool: "m365_mail_send" }] }],
      }),
    );
    const set = loadRoutines(
      { id: "pabcdefghij", folder, templateId: null },
      path.join(root, "home"),
    );
    expect(set.routines).toEqual([]);
    expect(set.error).toMatch(/write tool/);
    expect(set.source.kind).toBe("project");
  });

  it("no file → no routines, no error", () => {
    const set = loadRoutines(
      { id: "pabcdefghij", folder: path.join(root, "none"), templateId: null },
      path.join(root, "home"),
    );
    expect(set).toMatchObject({ routines: [], error: null, source: { kind: "none" } });
  });
});

describe("starter routines", () => {
  const packs = path.join(resolveTemplatesDir(), "packs");
  const cases: Array<[string, string, string, string]> = [
    [
      path.join(packs, "business-general-affairs", "autopilot.yaml"),
      "secretariat-inbox",
      "business",
      "L1",
    ],
    [
      path.join(packs, "business-finance-expense-invoice", "autopilot.yaml"),
      "finance-invoice-intake",
      "business",
      "L1",
    ],
    [
      path.join(packs, "industry-legacy-modernisation", "autopilot.yaml"),
      "nightly-legacy-analysis",
      "industrial",
      "L1",
    ],
    [path.join(packs, "research-academic", "autopilot.yaml"), "literature-watch", "scholars", "L1"],
    [
      path.join(resolveTemplatesDir(), "..", "autopilot", "core-platform-health.yaml"),
      "platform-health",
      "core",
      "L2",
    ],
    [
      path.join(resolveTemplatesDir(), "..", "autopilot", "core-linked-cases.yaml"),
      "linked-cases",
      "core",
      "L2",
    ],
  ];
  it.each(cases)("%s is valid", (file, id, edition, level) => {
    const [r] = parseRoutines(fs.readFileSync(file, "utf8"));
    expect(r).toMatchObject({ id, edition, level, enabled: true });
    // Starters never send, pay or delete.
    expect(r.actions).not.toContain("mail.send");
  });

  it("the finance starter only intakes (payments never)", () => {
    const [r] = parseRoutines(fs.readFileSync(cases[1][0], "utf8"));
    expect(r.actions).toEqual(["workitem.intake"]);
  });

  it("the linked-cases starter only reads workitems_linked and intakes one item", () => {
    const [r] = parseRoutines(fs.readFileSync(cases[cases.length - 1][0], "utf8"));
    expect(r.gather.map((g) => g.tool)).toEqual(["workitems_linked"]);
    expect(r.actions).toEqual(["workitem.intake"]);
    expect(r.reasoning.promptId).toBe("linked-cases");
    expect(r.limits.maxItemsPerRun).toBe(1);
  });

  it("the Industrial starter gates on legacy_changes and advances the baseline last", () => {
    const [r] = parseRoutines(fs.readFileSync(cases[2][0], "utf8"));
    expect(r.gather.map((g) => [g.id, g.tool, g.gate ?? false])).toEqual([
      ["changes", "legacy_changes", true],
      ["waves", "legacy_wave_plan", false],
    ]);
    expect(r.actions).toEqual(["legacy.design_doc", "workitem.intake", "legacy.baseline_advance"]);
    expect(r.reasoning.promptId).toBe("legacy-changes");
  });

  it("refuses a non-boolean gate and a gate that fans out", () => {
    const base = {
      id: "g",
      edition: "industrial",
      area: "analysis",
      trigger: { schedule: "0 1 * * *" },
      reasoning: { prompt: "legacy-changes" },
      actions: [],
      level: "L1",
    };
    const yaml = (gather: unknown[]) =>
      JSON.stringify({ version: 1, routines: [{ ...base, gather }] });
    expect(() =>
      parseRoutines(yaml([{ id: "c", tool: "legacy_changes", args: { path: "s" }, gate: "yes" }])),
    ).toThrow(/gate must be true or false/);
    expect(() =>
      parseRoutines(
        yaml([
          { id: "a", tool: "legacy_index", args: { path: "s" } },
          {
            id: "c",
            tool: "legacy_changes",
            gate: true,
            each: { from: "a", match: "(x)", arg: "path", max: 1 },
          },
        ]),
      ),
    ).toThrow(/gate step cannot fan out/);
  });

  it("a template project picks up its pack's routines", () => {
    const set = loadRoutines(
      { id: "pabcdefghij", folder: "/nonexistent", templateId: "business-general-affairs" },
      os.tmpdir(),
    );
    expect(set.error).toBeNull();
    expect(set.source.kind).toBe("template");
    expect(set.routines.map((r) => r.id)).toEqual(["secretariat-inbox"]);
  });
});
