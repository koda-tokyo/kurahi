import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ParseInput } from "./formats/types.js";
import { readFolderBundle } from "./bundle.js";
import { docgenRole, parseDocgenMd } from "./formats/docgen-md.js";
import { earsPattern, parseEarsRequirementsMd } from "./formats/ears-requirements-md.js";
import { globToRegExp, parseCsv, parseGenericMapped } from "./formats/generic-mapped.js";
import { parseNeo4jJsonl } from "./formats/neo4j-jsonl.js";
import { parseManifest, sha256Hex } from "./manifest.js";

const FIXTURES = path.join(import.meta.dirname, "test-fixtures");

function inputOf(fixture: string): ParseInput {
  const files = readFolderBundle(path.join(FIXTURES, fixture));
  const manifest = parseManifest(files);
  const pick = (role: string) =>
    manifest.files
      .filter((f) => f.role === role)
      .map((f) => ({ path: f.path, sha256: f.sha256, bytes: files.get(f.path)! }));
  return { manifest, data: pick("data"), mapping: pick("mapping")[0] ?? null };
}

function inputFrom(files: Record<string, string>, mapping?: string): ParseInput {
  const data = Object.entries(files).map(([p, text]) => ({
    path: p,
    sha256: sha256Hex(text),
    bytes: Buffer.from(text),
  }));
  return {
    manifest: {} as never,
    data,
    mapping: mapping
      ? { path: "kurahi-mapping.json", sha256: sha256Hex(mapping), bytes: Buffer.from(mapping) }
      : null,
  };
}

const err = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error("expected a rejection");
};

describe("Google MAT Neo4j JSON Lines (documented envelope)", () => {
  it("maps nodes to items and relationships to unverified edges with file:line", () => {
    const r = parseNeo4jJsonl(inputOf("google-mat-neo4j"));
    const a = r.artefacts;
    expect(a.items.map((i) => `${i.kind}:${i.name}`)).toEqual([
      "Program:PAYCALC",
      "Program:TAXCALC",
      "JclJob:PAYJOB",
      "Dataset:PAY.MASTER",
      "Database:Table:db-EMPLOYEE",
      "BmsMap:PAYMAP",
    ]);
    expect(a.items[4].nameFrom).toBe("id");
    expect(a.edges.map((e) => `${e.fromName} ${e.relation} ${e.toName}`)).toEqual([
      "PAYCALC CALLS TAXCALC",
      "PAYJOB EXECUTES PAYCALC",
      "PAYCALC READS PAY.MASTER",
      "PAYCALC QUERIES db-EMPLOYEE",
    ]);
    // Only a literal Kurahi edge name is normalised; EXECUTES is kept verbatim, not mapped.
    expect(a.edges.map((e) => e.relationNormalised)).toEqual(["CALLS", null, "READS", "QUERIES"]);
    for (const e of a.edges) {
      expect(e.provenance).toBe("IMPORTED_VENDOR_ARTEFACT");
      expect(e.confidence).toBe("UNVERIFIED");
      expect(e.source.file).toBe("graph/assessment.jsonl");
      expect(e.source.line).toBeGreaterThan(6);
    }
    expect(a.findings).toHaveLength(1);
    expect(a.findings[0].title).toMatch(/not in the export/);
    expect(r.fingerprintDetail).toEqual([
      "node:id,labels,properties,type",
      "relationship:end,label,properties,start,type",
    ]);
  });

  it("rejects records outside the documented envelope instead of guessing (AC-036)", () => {
    const cases = [
      '{"n":{"id":1,"labels":["Program"]}}',
      '{"type":"node","id":"a"}',
      '{"type":"relationship","from":"a","to":"b","label":"CALLS"}',
      '{"type":"edge","start":{"id":"a"},"end":{"id":"b"},"label":"CALLS"}',
      "not json",
    ];
    for (const line of cases) {
      const e = err(() => parseNeo4jJsonl(inputFrom({ "g.jsonl": `${line}\n` })));
      expect(e.code, line).toBe("SCHEMA_REJECTED");
    }
  });
});

describe("AWS Transform requirements.md (documented parts)", () => {
  it("imports the business function, preconditions and EARS requirements with their ids", () => {
    const a = parseEarsRequirementsMd(inputOf("aws-transform-requirements")).artefacts;
    expect(a.items).toHaveLength(1);
    expect(a.items[0]).toMatchObject({
      kind: "business-function",
      name: "Payroll calculation: monthly gross-to-net workflow",
      properties: { workflowSections: 2 },
    });
    expect(a.rules.filter((r) => r.ruleType === "PRECONDITION")).toHaveLength(2);
    const reqs = a.rules.filter((r) => r.vendorId);
    expect(reqs.map((r) => `${r.vendorId}:${r.ruleType}`)).toEqual([
      "REQ-1.1:EARS_EVENT_DRIVEN",
      "REQ-1.2:EARS_UNWANTED_BEHAVIOUR",
      "REQ-2.1:EARS_UBIQUITOUS",
      "REQ-2.2:EARS_STATE_DRIVEN",
      "REQ-2.3:EARS_OPTIONAL_FEATURE",
    ]);
    expect(reqs[0].title).toMatch(/^1\. Validate employee pay data \| As a payroll clerk/);
    expect(reqs[0].source.line).toBe(14);
    expect(a.findings).toEqual([]);
  });

  it("reports requirements without an identifier and duplicates", () => {
    const md = [
      "# Billing",
      "## 1. Invoice",
      "- R1: The system shall total the lines.",
      "- R1: The system shall round to yen.",
      "- The system shall print the invoice.",
    ].join("\n");
    const a = parseEarsRequirementsMd(inputFrom({ "x/requirements.md": md })).artefacts;
    expect(a.rules).toHaveLength(3);
    expect(a.findings.map((f) => f.title).toSorted()).toEqual([
      "Duplicate requirement identifier",
      "Requirements without an identifier",
    ]);
  });

  it("rejects a Markdown file without the documented parts, and other file names", () => {
    expect(
      err(() => parseEarsRequirementsMd(inputFrom({ "requirements.md": "# Notes\nhello\n" }))).code,
    ).toBe("SCHEMA_REJECTED");
    expect(
      err(() =>
        parseEarsRequirementsMd(inputFrom({ "readme.md": "# A\n## 1. B\n- R1: x shall y\n" })),
      ).code,
    ).toBe("SCHEMA_REJECTED");
  });

  it("classifies EARS patterns by their keywords", () => {
    expect(earsPattern("If the file is empty, then the system shall stop")).toBe(
      "EARS_UNWANTED_BEHAVIOUR",
    );
    expect(earsPattern("If only")).toBe("EARS_UBIQUITOUS");
  });
});

describe("IBM Z Understand documentation generation (documented layout)", () => {
  it("imports programs, the application, business rules and name-only dependencies", () => {
    const a = parseDocgenMd(inputOf("ibm-z-docgen")).artefacts;
    expect(a.items.map((i) => `${i.kind}:${i.name}`)).toEqual([
      "application:application",
      "program:PAYCALC",
    ]);
    expect(a.items[1].properties.summary).toMatch(/^PAYCALC calculates/);
    expect(a.rules.map((r) => r.subject)).toEqual([
      "application",
      "application",
      "PAYCALC",
      "PAYCALC",
    ]);
    expect(a.edges.map((e) => `${e.fromName} ${e.relation} ${e.toName}`)).toEqual([
      "PAYCALC DEPENDS_ON TAXCALC",
      "PAYCALC DEPENDS_ON PAY.MASTER",
    ]);
    expect(a.notes.some((n) => /not a single name/.test(n))).toBe(true);
  });

  it("places files by the documented layout only", () => {
    expect(docgenRole("Documentation/programs/PAYCALC.md")).toEqual({
      kind: "program",
      program: "PAYCALC",
    });
    expect(docgenRole("export/Documentation/application_document.md")?.kind).toBe("application");
    expect(docgenRole("Documentation/PAYCALC.md")).toBeNull();
    expect(docgenRole("Documentation/programs/PAYCALC.html")).toBeNull();
    expect(
      err(() =>
        parseDocgenMd(inputFrom({ "Documentation/programs/X.md": "# X\n## Summary\ntext\n" })),
      ).code,
    ).toBe("SCHEMA_REJECTED");
    expect(
      err(() => parseDocgenMd(inputFrom({ "Documentation/other/X.md": "## Purpose\n" }))).code,
    ).toBe("SCHEMA_REJECTED");
  });
});

describe("generic mapped import (unverified schemas)", () => {
  it("imports rules from a CSV export through the mapping", () => {
    const a = parseGenericMapped(inputOf("ibm-z-rules-mapped")).artefacts;
    expect(a.rules.map((r) => [r.title, r.subject, r.source.line])).toEqual([
      ["Overtime rate", "PAYCALC", 2],
      ["Blank employee", "PAYCALC", 3],
    ]);
  });

  it("imports edges from a JSON export through the mapping", () => {
    const a = parseGenericMapped(inputOf("aws-transform-deps-mapped")).artefacts;
    expect(
      a.edges.map((e) => `${e.fromName} ${e.relation} ${e.toName} ${e.relationNormalised}`),
    ).toEqual(["PAYCALC CALLS TAXCALC CALLS", "PAYJOB EXECUTES PAYCALC null"]);
  });

  it("refuses without a mapping, with a missing column, an empty required value or an unmapped file", () => {
    const csv = "Rule,Text\nA,first\nB,\n";
    const map = (fields: Record<string, string>, file = "r.csv") =>
      JSON.stringify({
        schema: "kurahi.vendor-import-mapping/1",
        tables: [{ file, format: "csv", produces: "rules", fields }],
      });
    expect(err(() => parseGenericMapped(inputFrom({ "r.csv": csv }))).message).toMatch(
      /no published schema/,
    );
    expect(
      err(() => parseGenericMapped(inputFrom({ "r.csv": csv }, map({ text: "Body" })))).message,
    ).toMatch(/no column "Body"/);
    expect(
      err(() => parseGenericMapped(inputFrom({ "r.csv": csv }, map({ text: "Text" })))).message,
    ).toMatch(/record 2: required text/);
    expect(
      err(() =>
        parseGenericMapped(
          inputFrom({ "r.csv": "Text\nx\n", "other.json": "{}" }, map({ text: "Text" })),
        ),
      ).message,
    ).toMatch(/not mapped/);
    expect(
      err(() => parseGenericMapped(inputFrom({ "r.csv": csv }, map({ text: "Text" }, "x.csv"))))
        .message,
    ).toMatch(/matches no file/);
  });

  it("parses CSV per RFC 4180 and matches globs per segment", () => {
    expect(parseCsv('a,"b,c","d ""q"""\r\n1,2,3\n')).toEqual([
      ["a", "b,c", 'd "q"'],
      ["1", "2", "3"],
    ]);
    expect(globToRegExp("reports/*.json").test("reports/PAYCALC.json")).toBe(true);
    expect(globToRegExp("reports/*.json").test("reports/x/PAYCALC.json")).toBe(false);
    expect(globToRegExp("**/*.json").test("a/b/c.json")).toBe(true);
    expect(globToRegExp("**/*.json").test("c.json")).toBe(true);
  });
});

describe("fixtures", () => {
  it("every fixture manifest matches its files", () => {
    for (const dir of fs.readdirSync(FIXTURES).filter((d) => !d.endsWith(".md"))) {
      const files = readFolderBundle(path.join(FIXTURES, dir));
      const m = parseManifest(files);
      for (const f of m.files) {
        expect(sha256Hex(files.get(f.path)!), `${dir}/${f.path}`).toBe(f.sha256);
      }
    }
  });
});
