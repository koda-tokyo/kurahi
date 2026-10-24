import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyDesignDoc } from "./api.js";
import { runCli } from "./cli.js";
import { designDoc } from "./design-doc.js";
import { buildIndex } from "./indexer.js";
import { demoPack, namedTree, uncitedFactLines } from "./test-fixtures/doc-check.js";
import { MIXED_FILES } from "./test-fixtures/mixed.js";
import { renderWavePlan } from "./wave-plan-md.js";

const root = namedTree("orders", { ...MIXED_FILES, "output/.keep": "" });
const index = buildIndex(root);
const ja = designDoc(index, { lang: "ja" }).markdown;
const en = designDoc(index, { lang: "en" }).markdown;
const JAPANESE = /[぀-ヿ一-鿿]/;

describe("design document", () => {
  it("cites path:line on every fact line, in both languages", () => {
    expect(uncitedFactLines(ja)).toEqual([]);
    expect(uncitedFactLines(en)).toEqual([]);
    // The test is not vacuous: there are many fact lines.
    expect(ja.split("\n").filter((l) => l.startsWith("| `")).length).toBeGreaterThan(30);
  });

  it("has the 設計書 structure in Japanese and the same structure in English", () => {
    for (const h of [
      "## 1. システム概要",
      "## 2. ジョブフロー",
      "## 3. プログラム仕様書",
      "## 4. データ項目定義書",
      "## 5. CRUD マトリクス",
      "## 6. カバレッジと要確認事項",
      "#### 3.1.6 業務ルール候補",
    ]) {
      expect(ja).toContain(h);
    }
    for (const h of [
      "## 1. System overview",
      "## 2. Job flow",
      "## 3. Program specifications",
      "## 4. Data dictionary",
      "## 5. CRUD matrix",
      "## 6. Coverage and open questions",
    ]) {
      expect(en).toContain(h);
    }
    expect(en).not.toMatch(JAPANESE);
    expect(ja.split("\n").length).toBe(en.split("\n").length);
  });

  it("states what code cannot tell as an explicit placeholder", () => {
    for (const p of ["ORDLOG", "ORDMAIN", "ORDRPT"]) {
      expect(ja).toContain(`${p} の業務目的：要確認`);
      expect(en).toContain(`Business purpose of ${p}: needs confirmation`);
    }
    // Every rule candidate row leaves its business meaning to a person.
    const rules = ja.split("\n").filter((l) => /^\| `ORD[A-Z]+-R\d{3}`/.test(l));
    expect(rules.length).toBeGreaterThan(3);
    expect(rules.every((l) => l.includes("| 要確認 |"))).toBe(true);
    // A condition shows the declared value of the named constant it tests, with its line.
    expect(en).toMatch(/`IF ORD-AMT > WS-LIMIT` \|.*WS-LIMIT=05000 \(cobol\/ORDMAIN\.cbl:\d+\)/);
  });

  it("reports unresolved and dynamic calls, missing copybooks, utility steps and other gaps", () => {
    const cov = en.slice(en.indexOf("## 6."));
    expect(cov).toMatch(
      /CALL target without source \| `ORDMAIN → EXTUTIL` .*`cobol\/ORDMAIN\.cbl:\d+`/,
    );
    expect(cov).toMatch(/Dynamic CALL \| `ORDMAIN → WS-PGM` \| VALUE 'ORDDYN'/);
    expect(cov).toMatch(/Copybook not found \| `NOSUCH` .*`cobol\/ORDMAIN\.cbl:17`/);
    expect(cov).toMatch(/Step runs a program without source \| `ORDJOB\.S20` \| IEBGENER/);
    expect(cov).toMatch(/not PERFORMed or GO TO target \| `ORDMAIN\.9000-UNUSED`/);
    expect(cov).toContain("`notes/README.txt`");
  });

  it("builds the CRUD matrix and the job flow from the graph", () => {
    const crud = en.slice(en.indexOf("## 5."), en.indexOf("## 6."));
    const row = crud.split("\n").find((l) => l.startsWith("| `ORDMAIN` |"));
    expect(row).toBeDefined();
    expect(row).toContain("| RUD |");
    expect(crud).toMatch(/\| `IEBGENER` \|.*\| \? \|/);
    const jobs = en.slice(en.indexOf("## 2."), en.indexOf("## 3."));
    expect(jobs).toContain("```mermaid");
    expect(jobs).toMatch(/\[\("#38;#38;ORDTMP \(ORDJOB\)"\)\]/);
    expect(jobs).toMatch(/\| S20 \| IEBGENER \(no source\) \|/);
  });

  it("is deterministic: the same sources give a byte-identical document, wherever they are", () => {
    expect(designDoc(buildIndex(root), { lang: "ja" }).markdown).toBe(ja);
    const copy = namedTree("orders", { ...MIXED_FILES, "output/.keep": "" });
    expect(designDoc(buildIndex(copy), { lang: "ja" }).markdown).toBe(ja);
    expect(designDoc(buildIndex(copy), { lang: "en" }).markdown).toBe(en);
    expect(ja).not.toContain(path.dirname(root));
  });

  it("narrows to sections and one program, and rejects an unknown program", () => {
    const one = designDoc(index, {
      lang: "en",
      sections: ["programs"],
      program: "ordrpt",
    }).markdown;
    expect(one).toContain("### 1.1 ORDRPT");
    expect(one).not.toContain("ORDMAIN.cbl");
    expect(uncitedFactLines(one)).toEqual([]);
    expect(() => designDoc(index, { program: "NOPE" })).toThrow(/No program named NOPE/);
  });

  it("saves the document in the analyser cache folder and has a command line", () => {
    const env = { stateDir: path.join(root, "state") };
    const r = legacyDesignDoc(root, { lang: "en" }, env);
    expect(r.savedTo).toBe(path.join(root, "output", ".legacy-index", "design-doc-en.md"));
    expect(fs.readFileSync(r.savedTo, "utf8")).toBe(en);
    const out = path.join(root, "output", "cli-ja.md");
    const msgs: string[] = [];
    const io = { out: (s: string) => msgs.push(s), err: (s: string) => msgs.push(s) };
    expect(runCli(["design-doc", root, "--lang", "ja", "--out", out], io)).toBe(0);
    expect(fs.readFileSync(out, "utf8")).toBe(ja);
    expect(runCli(["design-doc", root, "--lang", "fr"], io)).toBe(2);
    expect(runCli(["design-doc", root, "--section", "nope"], io)).toBe(2);
  });
});

const pack = demoPack();

describe.skipIf(!pack)("design document of the demo pack", () => {
  it("cites every fact line and finds the payroll job, programs and copybooks", () => {
    const idx = buildIndex(pack as string);
    for (const lang of ["ja", "en"] as const) {
      const md = designDoc(idx, { lang }).markdown;
      expect(uncitedFactLines(md)).toEqual([]);
      expect(md).toContain("`source/jcl/PY01MNTH.jcl:17`");
      expect(md).not.toContain("_answer-keys/");
    }
    const md = designDoc(idx, { lang: "en" }).markdown;
    expect(md).toMatch(/\| `PAYVAL` \|.*\| C \|/);
    expect(md).toMatch(/Record EMP-RECORD: 80 bytes/);
    expect(md).toMatch(/Record PAY-RECORD: 120 bytes/);
  });

  it("matches the committed samples (regenerate them with the command line when this fails)", () => {
    const dir = path.join(import.meta.dirname, "..", "examples", "payroll-demo");
    if (path.basename(pack as string) !== "industry-legacy-cobol") {
      return; // the samples are titled after the pack folder
    }
    const idx = buildIndex(pack as string);
    for (const lang of ["ja", "en"] as const) {
      expect(designDoc(idx, { lang }).markdown).toBe(
        fs.readFileSync(path.join(dir, `design-doc.${lang}.md`), "utf8"),
      );
      expect(renderWavePlan(idx, lang)).toBe(
        fs.readFileSync(path.join(dir, `wave-plan.${lang}.md`), "utf8"),
      );
    }
  });
});
