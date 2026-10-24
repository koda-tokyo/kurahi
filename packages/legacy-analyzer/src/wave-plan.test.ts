import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyWavePlan } from "./api.js";
import { buildIndex } from "./indexer.js";
import { demoPack, namedTree, uncitedFactLines } from "./test-fixtures/doc-check.js";
import { A, B, program } from "./test-fixtures/helpers.js";
import { MIXED_FILES } from "./test-fixtures/mixed.js";
import { renderWavePlan } from "./wave-plan-md.js";
import { type WavePlan, stronglyConnected, wavePlan } from "./wave-plan.js";

const bare = (id: string) => id.replace(/^program:/, "");

/** Every dependency points to the same wave (a cycle) or an earlier one. */
function expectOrdered(plan: WavePlan) {
  const group = new Map<string, number>();
  plan.waves.forEach((w) =>
    w.groups.forEach((g, k) => g.programs.forEach((p) => group.set(p, w.number * 1000 + k))),
  );
  for (const d of plan.dependencies) {
    const from = bare(d.from);
    const to = bare(d.to);
    if (group.get(from) === group.get(to)) {
      expect(
        plan.cycles.some((c) => c.includes(from) && c.includes(to)),
        `${from}->${to}`,
      ).toBe(true);
    } else {
      expect(plan.waveOf[to], `${from} -> ${to}`).toBeLessThan(plan.waveOf[from]);
    }
  }
}

// A calls B, B calls C; D reads the data set A writes; E stands alone.
const chain = {
  "cobol/A.cbl": program("A", {
    env: [A("INPUT-OUTPUT SECTION."), A("FILE-CONTROL."), B("SELECT OUT-F ASSIGN TO AOUT.")],
    data: [A("FILE SECTION."), A("FD  OUT-F."), A("01  OUT-R PIC X(10).")],
    proc: [
      A("0000-MAIN."),
      B("OPEN OUTPUT OUT-F"),
      B("CALL 'B'"),
      B("WRITE OUT-R"),
      B("STOP RUN."),
    ],
  }),
  "cobol/B.cbl": program("B", { proc: [A("0000-MAIN."), B("CALL 'C'"), B("GOBACK.")] }),
  "cobol/C.cbl": program("C", {
    proc: [
      A("0000-MAIN."),
      B("IF RETURN-CODE > 0"),
      B("    GO TO 9000-X"),
      B("END-IF."),
      A("9000-X."),
      B("GOBACK."),
    ],
  }),
  "cobol/D.cbl": program("D", {
    env: [A("INPUT-OUTPUT SECTION."), A("FILE-CONTROL."), B("SELECT IN-F ASSIGN TO DIN.")],
    data: [A("FILE SECTION."), A("FD  IN-F."), A("01  IN-R PIC X(10).")],
    proc: [A("0000-MAIN."), B("OPEN INPUT IN-F"), B("READ IN-F"), B("STOP RUN.")],
  }),
  "cobol/E.cbl": program("E", { proc: [A("0000-MAIN."), B("STOP RUN.")] }),
  "jcl/J.jcl": [
    "//J        JOB (A),'CHAIN'",
    "//S1       EXEC PGM=A",
    "//AOUT     DD DSN=P.A.OUT,DISP=(NEW,CATLG)",
    "//S2       EXEC PGM=D",
    "//DIN      DD DSN=P.A.OUT,DISP=SHR",
  ].join("\n"),
};

describe("wave plan", () => {
  it("orders waves by dependency: called and producing programs first", () => {
    const plan = wavePlan(buildIndex(namedTree("chain", chain)));
    expect(plan.waveOf).toEqual({ A: 3, B: 2, C: 1, D: 4, E: 1 });
    expectOrdered(plan);
    expect(plan.dependencies.map((d) => `${bare(d.from)}>${bare(d.to)}:${d.kind}`)).toEqual([
      "A>B:CALL",
      "B>C:CALL",
      "D>A:DATA",
    ]);
    expect(plan.clusters).toEqual([["A", "B", "C", "D"], ["E"]]);
    // C has a GO TO: a risk factor with its line.
    const c = plan.risks.find((r) => r.program === "C");
    expect(c?.factors.find((f) => f.factor === "goTo")).toMatchObject({ count: 1, points: 1 });
  });

  it("keeps a CALL cycle together and puts its readers after it", () => {
    const plan = wavePlan(buildIndex(namedTree("orders", MIXED_FILES)));
    expect(plan.cycles).toEqual([["ORDLOG", "ORDMAIN"]]);
    expect(plan.waveOf.ORDLOG).toBe(plan.waveOf.ORDMAIN);
    expect(plan.waveOf.ORDRPT).toBeGreaterThan(plan.waveOf.ORDMAIN);
    const group = plan.waves.flatMap((w) => w.groups).find((g) => g.programs.includes("ORDMAIN"));
    expect(group).toMatchObject({ programs: ["ORDLOG", "ORDMAIN"], cycle: true });
    expectOrdered(plan);
    const main = plan.risks.find((r) => r.program === "ORDMAIN");
    expect(main?.factors.map((f) => f.factor)).toEqual(
      expect.arrayContaining(["dynamicCalls", "unresolvedCalls", "sql", "missingCopybooks"]),
    );
    expect(plan.outOfScope.map((o) => `${o.kind}:${o.name}`)).toEqual([
      "dynamic:ORDMAIN.WS-PGM",
      "external:EXTUTIL",
      "external:IEBGENER",
    ]);
  });

  it("finds strongly connected components", () => {
    const edges = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]],
      ["d", ["c"]],
    ]);
    expect(stronglyConnected(["d", "c", "b", "a"], edges)).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("renders a labelled proposal, cited and byte-identical for the same input", () => {
    const root = namedTree("orders", { ...MIXED_FILES, "output/.keep": "" });
    const index = buildIndex(root);
    const ja = renderWavePlan(index, "ja");
    const en = renderWavePlan(index, "en");
    expect(ja).toContain("（案）");
    expect(ja).toContain("担当者によるレビューを前提とした提案");
    expect(en).toContain("Proposal for human review");
    expect(en).not.toMatch(/[぀-ヿ一-鿿]/);
    expect(uncitedFactLines(ja)).toEqual([]);
    expect(uncitedFactLines(en)).toEqual([]);
    expect(renderWavePlan(buildIndex(namedTree("orders", MIXED_FILES)), "ja")).toBe(ja);
    const saved = legacyWavePlan(root, "en", { stateDir: path.join(root, "state") });
    expect(saved.savedTo).toBe(path.join(root, "output", ".legacy-index", "wave-plan-en.md"));
    expect(saved.markdown).toBe(en);
  });
});

const pack = demoPack();

describe.skipIf(!pack)("wave plan of the demo pack", () => {
  it("puts PAYRND and PAYVAL first, then PAYCALC, then PAYRPT", () => {
    const plan = wavePlan(buildIndex(pack as string));
    expect(plan.waveOf).toEqual({ PAYCALC: 2, PAYRND: 1, PAYRPT: 3, PAYVAL: 1 });
    expectOrdered(plan);
    // PAYCALC reads what PAYVAL writes through the SORT step.
    const d = plan.dependencies.find(
      (x) => x.from === "program:PAYCALC" && x.to === "program:PAYVAL",
    );
    expect(d?.via).toEqual(["dataset:PY01MNTH/&&VALID", "dataset:PY01MNTH/&&SORTED"]);
    expect(uncitedFactLines(renderWavePlan(buildIndex(pack as string), "ja"))).toEqual([]);
  });
});
