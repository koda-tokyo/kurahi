import { describe, expect, it } from "vitest";
import { B, program, tmpTree } from "../test-fixtures/helpers.js";
import { POLY_FILES } from "../test-fixtures/payroll-poly.js";
import { LANGUAGES, detectLanguages } from "./registry.js";
import { scanProject } from "./scan.js";

describe("language registry", () => {
  it("has the active engines and honest planned entries", () => {
    expect(LANGUAGES.map((l) => `${l.id}:${l.status}`)).toEqual([
      "cobol:active",
      "java:active",
      "sql-ddl:active",
      "fortran:active",
      "pli:active",
      "plc-iec61131:active",
      "batch-scheduler:planned",
      "maintenance:planned",
      "cybersecurity:planned",
    ]);
    for (const l of LANGUAGES) {
      expect(Boolean(l.engine)).toBe(l.status === "active");
      if (l.status === "planned") {
        expect(l.description).toMatch(/^Planned: no /);
      }
      expect(`${l.description} ${l.label.en} ${l.label.ja}`).not.toMatch(
        /\b(GPT|OpenAI|Claude|Anthropic|Gemini|LLM)\b/i,
      );
    }
  });

  it("detects by extension and by content", () => {
    const root = tmpTree({
      ...POLY_FILES,
      "misc/SCHEMA.txt": "-- exported\nCREATE TABLE X (A INT);",
      "misc/OLDPGM": "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. OLDPGM.",
      "misc/sched.xml": "<DEFTABLE><SMART_FOLDER/></DEFTABLE>",
      "misc/wo.csv": "work_order,asset_id,failure_code\n1,2,3",
      "misc/rates.txt": "nothing to see",
    });
    const { detections } = detectLanguages(scanProject(root).files);
    const by = Object.fromEntries(detections.map((d) => [d.id, d.examples]));
    expect(by.cobol).toEqual(["cobol/PAYPOST.cbl", "jcl/PY02POST.jcl", "misc/OLDPGM"]);
    expect(by["sql-ddl"]).toEqual(["db/db2/payroll.sql", "db/oracle/audit.ddl", "misc/SCHEMA.txt"]);
    expect(by.java).toHaveLength(7);
    expect(by.fortran).toEqual(["legacy/fortran/RATES.f90"]);
    expect(by["plc-iec61131"]).toEqual(["plc/line1/Conveyor.st"]);
    expect(by["batch-scheduler"]).toEqual(["misc/sched.xml"]);
    expect(by.maintenance).toEqual(["misc/wo.csv"]);
    expect(by.cybersecurity).toEqual([]);
  });

  it("routes a content-sniffed file that embeds SQL to its host engine only", () => {
    const root = tmpTree({
      "src/SETUPV": program("SETUPV", {
        proc: [
          B("EXEC SQL"),
          B("  CREATE VIEW V1 AS SELECT A FROM T1"),
          B("END-EXEC."),
          B("GOBACK."),
        ],
      }),
      "src/LOADJOB":
        "//LOADJOB JOB (ACCT)\n//STEP1 EXEC PGM=IKJEFT01\n//SYSIN DD *\n  CREATE TABLE T2 (A INT);\n/*\n",
      "src/SCHEMA.txt": "CREATE TABLE T3 (A INT);",
      "plc/MIXED.txt":
        "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. MIXED.\n* END_PROGRAM\n",
    });
    const { detections, byLanguage } = detectLanguages(scanProject(root).files);
    const by = Object.fromEntries(detections.map((d) => [d.id, d]));
    expect(by.cobol.examples).toEqual(["plc/MIXED.txt", "src/LOADJOB", "src/SETUPV"]);
    expect(by["sql-ddl"].examples).toEqual(["src/SCHEMA.txt"]);
    expect(by["sql-ddl"].routedElsewhere).toBe(2);
    expect(by.cobol.routedElsewhere).toBeUndefined();
    expect(byLanguage.get("sql-ddl")?.map((f) => f.path)).toEqual(["src/SCHEMA.txt"]);
    // The PLC engine is active too: the COBOL program that mentions END_PROGRAM stays COBOL.
    expect(by["plc-iec61131"].examples).toEqual([]);
    expect(by["plc-iec61131"].routedElsewhere).toBe(1);
  });
});
