import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EmptyKnowledgeArg, knowledgeValues, parseArgRef, resolveArgs } from "./args.js";
import { filesFolderError, loadRoutines, parseRoutines } from "./routines.js";

const K = ["knowledge/research-profile.md"];
const PROFILE = `# Research profile
<!-- ## Topics
- commented example -->
## Topics
- retrieval-augmented generation
* "federated learning"
- retrieval-augmented generation

## Keywords
- dementia
Sources:
- arxiv
- pubmed
## Languages
`;

const file = (text: string, p = K[0]) => ({ path: p, text, bytes: text.length, truncated: false });
const ctx = (text = PROFILE, lastSuccessAt: string | null = null) => ({
  knowledge: [file(text)],
  lastSuccessAt,
  now: new Date("2026-10-26T00:30:00Z"),
  tz: "Asia/Tokyo",
});

describe("knowledge key lists", () => {
  it("reads headings and `key:` lines, bullets only, deduplicated, comments ignored", () => {
    expect(knowledgeValues(PROFILE, "topics")).toEqual([
      "retrieval-augmented generation",
      "federated learning",
    ]);
    expect(knowledgeValues(PROFILE, "sources")).toEqual(["arxiv", "pubmed"]);
    expect(knowledgeValues(PROFILE, "languages")).toEqual([]);
    expect(knowledgeValues(PROFILE, "funders")).toBeNull();
  });

  it("bounds each value", () => {
    const long = `## Topics\n- ${"x".repeat(500)}\n`;
    expect(knowledgeValues(long, "topics")![0]).toHaveLength(200);
  });
});

describe("argument references", () => {
  it("resolves fromKnowledge, lastRun and today; literals pass through", () => {
    const args = {
      queries: { fromKnowledge: "topics", max: 1 },
      sources: { fromKnowledge: "sources" },
      joined: { fromKnowledge: "topics", join: " OR " },
      since: { var: "lastRun", fallbackDays: 14 },
      day: { var: "today" },
      limit: 20,
      filter: { any: "object" },
    };
    expect(resolveArgs(args, ctx(), K)).toEqual({
      queries: ["retrieval-augmented generation"],
      sources: ["arxiv", "pubmed"],
      joined: "retrieval-augmented generation OR federated learning",
      since: "2026-10-12",
      day: "2026-10-26",
      limit: 20,
      filter: { any: "object" },
    });
    expect(
      resolveArgs({ since: { var: "lastRun" } }, ctx(PROFILE, "2026-10-19T22:00:00.000Z"), K),
    ).toEqual({
      since: "2026-10-19",
    });
  });

  it("an empty list: no_input unless optional (then the argument is left out)", () => {
    expect(() => resolveArgs({ l: { fromKnowledge: "languages" } }, ctx(), K)).toThrow(
      EmptyKnowledgeArg,
    );
    expect(() => resolveArgs({ l: { fromKnowledge: "missing" } }, ctx(), K)).toThrow(
      /knowledge key missing lists no values/,
    );
    expect(
      resolveArgs({ l: { fromKnowledge: "languages", optional: true }, n: 1 }, ctx(), K),
    ).toEqual({
      n: 1,
    });
  });

  it("rejects malformed references", () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ fromKnowledge: "Topics!" }, /key name/],
      [{ fromKnowledge: "topics", max: 99 }, /max must be an integer from 1 to 25/],
      [
        { fromKnowledge: "topics", file: "knowledge/other.md" },
        /one of the routine's knowledge files/,
      ],
      [{ fromKnowledge: "topics", extra: 1 }, /unknown key extra/],
      [{ fromKnowledge: "topics", join: "--------x" }, /separator/],
      [{ var: "yesterday" }, /var must be one of lastRun, today/],
      [{ var: "today", fallbackDays: 3 }, /lastRun only/],
      [{ var: "lastRun", fallbackDays: 0 }, /fallbackDays/],
    ];
    for (const [v, re] of bad) {
      expect(() => parseArgRef(v, "x", K)).toThrow(re);
    }
    expect(() => parseArgRef({ fromKnowledge: "topics" }, "x", [])).toThrow(/declare knowledge/);
    expect(parseArgRef({ query: "literal" }, "x", K)).toBeNull();
  });
});

const routine = (extra: string) => `
version: 1
routines:
  - id: watch
    edition: scholars
    area: literature
    trigger: { schedule: "0 7 * * 1", tz: Asia/Tokyo }
    reasoning: { prompt: literature-watch }
    actions: [workitem.intake, office.create]
${extra}`;

describe("routines file: references, output folder, files triggers", () => {
  it("validates gather references when the file loads (fail closed)", () => {
    expect(() =>
      parseRoutines(
        routine(`    gather:
      - { id: s, tool: scholar_search, args: { queries: { fromKnowledge: topics } } }`),
      ),
    ).toThrow(/declare knowledge files/);
    const [r] = parseRoutines(
      routine(`    knowledge: [knowledge/research-profile.md]
    outputFolder: output/literature
    gather:
      - { id: s, tool: scholar_search, args: { queries: { fromKnowledge: topics }, since: { var: lastRun } } }`),
    );
    expect(r.outputFolder).toBe("output/literature");
    expect(r.gather[0].args.queries).toEqual({ fromKnowledge: "topics" });
  });

  it("outputFolder: a Project folder, never the root or the routines' own folder", () => {
    for (const bad of [".", "output/autopilot", "output/autopilot/x", "../out", "/abs"]) {
      expect(() => parseRoutines(routine(`    outputFolder: "${bad}"`))).toThrow(/outputFolder/);
    }
  });

  it("loading checks the output folder is writable and that no files trigger watches it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-args-"));
    fs.mkdirSync(path.join(dir, "context"));
    const write = (yaml: string) =>
      fs.writeFileSync(path.join(dir, "context", "autopilot.yaml"), yaml);
    const project = {
      id: "pabcdefghij",
      folder: dir,
      templateId: null,
      rules: {
        readOnly: ["knowledge"],
        writable: ["output"],
        artifactApprovalRequired: false,
        instructions: [],
      },
    };
    write(routine(`    outputFolder: corpus-inbox`));
    expect(loadRoutines(project).error).toMatch(/not under a writable folder/);
    write(
      `${routine(`    outputFolder: output/literature`)}
  - id: loop
    edition: scholars
    area: writing
    trigger: { event: [{ source: files, folder: output/literature }] }
    reasoning: { prompt: citation-check }
`,
    );
    expect(loadRoutines(project).error).toMatch(
      /overlaps the routines' output folder output\/literature/,
    );
    write(routine(`    outputFolder: output/literature`));
    expect(loadRoutines(project).error).toBeNull();
    expect(filesFolderError(project.rules, "output/drafts")).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
