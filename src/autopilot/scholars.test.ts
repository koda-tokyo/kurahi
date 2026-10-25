// The Scholars starter routines (Research & academic template), end to end: the REAL
// scholar-sources tools over recorded API responses (fake fetch, fake clock), the real office
// renderer, the real work queue; only the reasoner is a fake that returns a fixed plan.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../projects/types.js";
import type { Reasoner } from "./reasoner.js";
import type { ToolCall, ToolInvoker } from "./runner.js";
import { registerOfficeSpecParsers } from "../../extensions/office/index.js";
import { createOfficeTools } from "../../extensions/office/src/tools.js";
import { readSettings } from "../../extensions/scholar-sources/src/config.js";
import { createLimiters, ScholarHttp } from "../../extensions/scholar-sources/src/http.js";
import { createScholarTools } from "../../extensions/scholar-sources/src/tools.js";
import { fixture } from "../../extensions/scholar-sources/test-helpers.js";
import { flushAudit } from "../audit/audit-log.js";
import { seedStarterFiles } from "../projects/pack.js";
import { createProject, setProjectMode } from "../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../projects/templates.js";
import { loadWorkQueuePolicy } from "../workitems/policy.js";
import { readWorkItem } from "../workitems/store.js";
import { loadRoutines } from "./routines.js";
import { runRoutine } from "./runner.js";
import { routineState } from "./store.js";
import { defaultWorkItemSink } from "./workitems-adapter.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autopilot-scholars-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;
const NOW = new Date("2026-10-26T00:00:00Z"); // a Monday, 09:00 in Tokyo
const PROFILE = [
  "# Research profile",
  "## Topics",
  "- retrieval-augmented generation in clinical care",
  "- multimodal dementia diagnosis",
  "## Keywords",
  "- Alzheimer",
  "## Sources",
  "- openalex",
  "## Languages",
  "- ja",
].join("\n");

let project: Project;
let calls: ToolCall[] = [];
const work = JSON.parse(fixture("openalex-search.json"));
const http = new ScholarHttp(
  readSettings({ contactEmail: "lab@example.org" }),
  createLimiters(
    () => 0,
    async () => {},
  ),
  {
    fetch: async (input) => {
      const u = new URL(String(input));
      if (u.hostname === "api.openalex.org" && u.pathname === "/works") {
        return Response.json(work);
      }
      const one = work.results.find((r: Json) => u.pathname === `/works/doi:${r.doi.slice(16)}`);
      return one ? Response.json(one) : new Response("", { status: 404 });
    },
  },
);

const tools: ToolInvoker = async (call) => {
  calls.push(call);
  if (call.tool.startsWith("scholar_")) {
    const t = createScholarTools({
      http,
      limiters: createLimiters(
        () => 0,
        async () => {},
      ),
      ctx: { agentId: call.agentId, sessionKey: call.sessionKey },
      now: () => NOW,
    }).find((x) => x.name === call.tool)!;
    const r = (await t.execute("c1", call.args as never)) as Json;
    return { ok: true, text: r.content[0].text, details: r.details, pluginId: "scholar-sources" };
  }
  if (call.tool.startsWith("office_")) {
    const t = createOfficeTools({ sessionKey: call.sessionKey }).find((x) => x.name === call.tool)!;
    const r = (await t.execute("c1", call.args)) as Json;
    if (r.details?.error) {
      return { ok: false, error: r.content[0].text };
    }
    return { ok: true, text: r.content[0].text, details: r.details, pluginId: "office" };
  }
  return { ok: false, error: `unexpected tool ${call.tool}` };
};

let reply: Json = { items: [] };
let prompts: string[] = [];
const reasoner: Reasoner = {
  async reason(req) {
    prompts.push(req.prompt);
    return { text: JSON.stringify(reply), backend: "fake", model: null };
  },
};
let clock = NOW;
const deps = () => ({
  cfg: {},
  reasoner,
  tools,
  workItems: defaultWorkItemSink(),
  defaultAgentId: "main",
  now: () => clock,
});
const manual = { kind: "manual" as const, by: "device:person" };
const items = (ids: string[]) => ids.map((id) => readWorkItem(project.id, id)!);

beforeAll(() => {
  const folder = path.join(root, "lab");
  fs.mkdirSync(folder, { recursive: true });
  const template = loadTemplates(resolveTemplatesDir({})).find(
    (t) => t.id === "research-academic",
  )!;
  project = createProject(
    { name: "Lab", folder, allowedAgents: [] },
    { createdBy: "device:researcher", template },
  );
  seedStarterFiles(
    project,
    path.join(resolveTemplatesDir({}), "packs", template.id),
    template.starterFiles!,
  );
  project = setProjectMode(project.id, "act").project;
  registerOfficeSpecParsers();
});

beforeEach(() => {
  calls = [];
  prompts = [];
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

describe("Research & academic template", () => {
  it("has a work queue, its plugins, its folders and three valid L1 routines", () => {
    const policy = loadWorkQueuePolicy(project);
    expect(policy.error).toBeNull();
    expect(policy.queues.map((q) => q.id)).toEqual([
      "res-literature",
      "res-writing",
      "res-grants",
      "res-data",
    ]);
    expect(project.plugins).toEqual(["scholar-sources", "office"]);
    expect(project.rules).toMatchObject({
      readOnly: ["corpus", "knowledge"],
      writable: ["output", "corpus-inbox"],
    });
    const set = loadRoutines(project);
    expect(set.error).toBeNull();
    expect(
      set.routines.map((r) => [r.id, r.level, r.queue, r.agentId, r.requireCitations]),
    ).toEqual([
      ["literature-watch", "L1", "res-literature", null, true],
      ["citation-check", "L1", "res-writing", null, true],
      ["grant-deadlines", "L1", "res-grants", null, true],
    ]);
    for (const r of set.routines) {
      expect(r.actions.every((a) => a === "workitem.intake" || a === "office.create")).toBe(true);
      expect(policy.queues.some((q) => q.id === r.queue)).toBe(true);
    }
    expect(set.routines[0].outputFolder).toBe("output/literature");
  });
});

describe("literature-watch", () => {
  it("does nothing (no_input) while the research profile lists no topics", async () => {
    const run = await runRoutine(deps(), project, "literature-watch", manual);
    expect(run.status).toBe("no_input");
    expect(run.reason).toMatch(/knowledge key topics lists no values/);
    expect(calls).toHaveLength(0);
    expect(prompts).toHaveLength(0);
    // Nothing to search for is not a failure: the watch window moves on.
    expect(routineState(project.id, "literature-watch").lastSuccessAt).toBe(run.startedAt);
  });

  it("searches the profile's topics since the last run and files one cited item per paper plus a Word digest", async () => {
    fs.writeFileSync(path.join(project.folder, "knowledge", "research-profile.md"), PROFILE);
    clock = new Date(NOW.getTime() + 7 * 86_400_000);
    const prevSuccess = routineState(project.id, "literature-watch").lastSuccessAt!;
    reply = {
      items: [
        {
          ref: "doi:10.3390/make7030089",
          title: "AlzheimerRAG",
          summary:
            "Multimodal retrieval-augmented generation for clinical use cases. Relevant to the dementia topic. Lahiri AK, et al. (2025). AlzheimerRAG. Machine Learning and Knowledge Extraction. doi:10.3390/make7030089",
          priority: "normal",
          flags: [],
          sources: ["papers.1"],
          actions: [
            {
              kind: "workitem.intake",
              args: { type: "document", note: "https://doi.org/10.3390/make7030089" },
            },
          ],
        },
        {
          ref: "doi:10.1234/invented",
          title: "A paper nobody retrieved",
          summary: "Made up.",
          flags: [],
          sources: ["papers.9"],
          actions: [{ kind: "workitem.intake" }],
        },
        {
          ref: "digest",
          title: "Literature digest",
          summary: "Two new papers on the profile topics.",
          flags: [],
          sources: ["papers.1", "papers.2"],
          actions: [
            {
              kind: "office.create",
              args: {
                kind: "docx",
                file: "literature-digest.docx",
                spec: {
                  title: "Literature digest",
                  blocks: [
                    { type: "heading", level: 1, text: "AlzheimerRAG" },
                    {
                      type: "paragraph",
                      text: "Lahiri AK, et al. (2025). doi:10.3390/make7030089",
                    },
                  ],
                },
              },
            },
            { kind: "workitem.intake", args: { type: "document" } },
          ],
        },
      ],
    };
    const run = await runRoutine(deps(), project, "literature-watch", manual);
    expect(run.status).toBe("escalated");
    // Gather args came from the profile and from the last successful run.
    const search = calls.find((c) => c.tool === "scholar_search")!;
    expect(search.args).toEqual({
      queries: ["retrieval-augmented generation in clinical care", "multimodal dementia diagnosis"],
      sources: ["openalex"],
      since: prevSuccess.slice(0, 10),
      limit: 20,
    });
    expect(calls.filter((c) => c.tool === "scholar_get").map((c) => c.args.id)).toEqual([
      "doi:10.3390/make7030089",
      "doi:10.18653/v1/2025.findings-acl.517",
    ]);
    // The research profile is trusted knowledge; the papers are untrusted sources.
    expect(prompts[0]).toContain("multimodal dementia diagnosis");
    expect(prompts[0]).toContain("Run date: 2026-11-02.");
    expect(prompts[0].indexOf("KNOWLEDGE knowledge/research-profile.md")).toBeLessThan(
      prompts[0].indexOf("===== SOURCE papers.1"),
    );
    // The invented citation is flagged and gets no action; the others ran.
    expect(run.actions.map((a) => [a.item, a.kind, a.decision, a.executed])).toEqual([
      ["doi:10.3390/make7030089", "workitem.intake", "allow", true],
      ["doi:10.1234/invented", "workitem.intake", "refuse", false],
      // The intake is authorized and recorded first, then the item's other actions.
      ["digest", "workitem.intake", "allow", true],
      ["digest", "office.create", "allow", true],
    ]);
    const [paper, invented, digest] = items(run.workItems);
    expect(paper.queue).toBe("res-literature");
    expect(String(paper.source.fields.summary)).toContain("doi:10.3390/make7030089");
    expect(String(paper.source.fields.autopilotEvidence)).toBe(
      "papers.1 (scholar_get): ref: doi:10.3390/make7030089",
    );
    expect(invented.source.fields.autopilotFlags).toBe("unverified_citation");
    expect(invented.source.fields.awaitingPerson).toMatch(/flagged \(unverified_citation\)/);
    expect(invented.source.fields.autopilotEvidence).toBeUndefined();
    // The digest is a real Word file in output/literature/, named on the item.
    const doc = String(digest.source.fields.autopilotDocument);
    expect(doc).toBe(`output/literature/2026-11-02/${run.id}-3-literature-digest.docx`);
    expect(fs.readFileSync(path.join(project.folder, doc)).subarray(0, 2).toString()).toBe("PK");
    expect(String(digest.source.fields.autopilotEvidence).split("\n")).toHaveLength(2);
  });

  it("a week later with nothing new: no model call, nothing filed", async () => {
    clock = new Date(NOW.getTime() + 14 * 86_400_000);
    const before = routineState(project.id, "literature-watch").lastSuccessAt!;
    const run = await runRoutine(deps(), project, "literature-watch", manual);
    expect(run.status).toBe("no_input");
    expect(prompts).toHaveLength(0);
    expect(calls.find((c) => c.tool === "scholar_search")!.args.since).toBe(before.slice(0, 10));
    expect(calls.some((c) => c.tool === "scholar_get")).toBe(false);
  });
});

describe("grant-deadlines", () => {
  it("files one reminder per deadline distance, once", async () => {
    clock = NOW;
    fs.writeFileSync(
      path.join(project.folder, "knowledge", "grants.md"),
      "## Deadlines\n- 2026-11-02 | 科研費 基盤研究(C) | 学内締切 2026-10-30\n- 2027-01-31 | later |\n",
    );
    reply = {
      items: [
        {
          ref: "grant:2026-11-02",
          title: "科研費 基盤研究(C): 締切 2026-11-02（7日）",
          summary: "締切まで7日です。学内締切（2026-10-30）は確認済みですか？",
          priority: "high",
          flags: [],
          sources: ["reminder.1"],
          actions: [{ kind: "workitem.intake", args: { type: "case" } }],
        },
      ],
    };
    const first = await runRoutine(deps(), project, "grant-deadlines", manual);
    expect(first.status).toBe("ok");
    const [item] = items(first.workItems);
    expect(item.queue).toBe("res-grants");
    expect(String(item.source.fields.autopilotEvidence)).toMatch(
      /^reminder\.1 \(scholar_grant_deadlines\): ref: grant:[0-9a-f]{10}:2026-11-02:d7$/,
    );
    const again = await runRoutine(deps(), project, "grant-deadlines", manual);
    expect(again.status).toBe("no_input");
    expect(prompts).toHaveLength(1);
  });
});

describe("citation-check", () => {
  it("checks each new draft version once and files the unverified references, flagged", async () => {
    fs.writeFileSync(
      path.join(project.folder, "output", "drafts", "chapter1.md"),
      "# Chapter 1\n\n## References\n1. Doe J. Invented results. 2021. arXiv:2501.99999\n",
    );
    reply = {
      items: [
        {
          ref: "draft:chapter1",
          title: "Citations to check: output/drafts/chapter1.md",
          summary: "Reference 1 (arXiv:2501.99999) does not resolve.",
          flags: ["unverified_citation"],
          sources: ["check.1"],
          actions: [{ kind: "workitem.intake" }],
        },
      ],
    };
    const run = await runRoutine(deps(), project, "citation-check", manual);
    expect(run.status).toBe("escalated");
    const check = calls.find((c) => c.tool === "scholar_cite_check" && c.args.draft)!;
    expect(String(check.args.draft)).toMatch(/^[0-9a-f]{12}:output%2Fdrafts%2Fchapter1\.md$/);
    const [item] = items(run.workItems);
    expect(item.queue).toBe("res-writing");
    expect(item.source.fields.autopilotFlags).toBe("unverified_citation");
    expect(String(item.source.fields.summary)).toContain("arXiv:2501.99999");
    // Same version again: nothing new, no model call.
    const again = await runRoutine(deps(), project, "citation-check", manual);
    expect(again.status).toBe("no_input");
    expect(prompts).toHaveLength(1);
  });
});
