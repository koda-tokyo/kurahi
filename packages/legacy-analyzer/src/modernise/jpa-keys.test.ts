import { describe, expect, it } from "vitest";
import { designDoc } from "../design-doc.js";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { compareJoinKeys } from "./jpa-keys.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { crossImpact } from "./poly-impact.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE DEPT (ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE SITE (SITE_CODE CHAR(4) PRIMARY KEY);
CREATE TABLE SHIFT (PLANT CHAR(4) NOT NULL, NO SMALLINT NOT NULL, PRIMARY KEY (PLANT, NO));
CREATE TABLE EMP (
  ID BIGINT PRIMARY KEY,
  DEPT_ID BIGINT REFERENCES DEPT(ID),
  MGR_ID BIGINT,
  SITE_SITE_CODE CHAR(4),
  SHIFT_PLANT CHAR(4),
  SHIFT_NO SMALLINT,
  FOREIGN KEY (MGR_ID) REFERENCES EMP(ID),
  FOREIGN KEY (SHIFT_NO, SHIFT_PLANT) REFERENCES SHIFT(NO, PLANT)
);
CREATE TABLE AUDIT_LOG (ID BIGINT, EMP_ID BIGINT REFERENCES EMP(ID));
`;

const entity = (name: string, table: string, body: string) => `package jp.kazanami.plant.domain;

@Entity
@Table(name = "${table}")
public class ${name} {
${body}
}
`;

const root = namedTree("jpa-keys", {
  "db/plant.sql": DDL,
  "src/main/java/jp/kazanami/plant/domain/Dept.java": entity(
    "Dept",
    "DEPT",
    "  @Id\n  private Long id;",
  ),
  "src/main/java/jp/kazanami/plant/domain/Site.java": entity(
    "Site",
    "SITE",
    '  @Id\n  @Column(name = "SITE_CODE")\n  private String code;',
  ),
  "src/main/java/jp/kazanami/plant/domain/Shift.java": entity(
    "Shift",
    "SHIFT",
    "  private String plant;",
  ),
  "src/main/java/jp/kazanami/plant/domain/Badge.java": entity(
    "Badge",
    "BADGE",
    "  @OneToOne\n  private Emp emp;",
  ),
  "src/main/java/jp/kazanami/plant/domain/Emp.java": entity(
    "Emp",
    "EMP",
    [
      "  @Id",
      "  private Long id;",
      "  @ManyToOne",
      '  @JoinColumn(name = "DEPT_ID", referencedColumnName = "ID")',
      "  private Dept dept;",
      "  @ManyToOne",
      "  private Site site;",
      "  @ManyToOne(targetEntity = Shift.class)",
      '  @JoinColumns({ @JoinColumn(name = "SHIFT_PLANT"), @JoinColumn(name = "SHIFT_NO") })',
      "  private Object shift;",
      '  @OneToOne(mappedBy = "emp")',
      "  private Badge badge;",
      "  @ManyToOne",
      '  @JoinColumn(name = "LOC_ID")',
      "  private Location location;",
    ].join("\n"),
  ),
});
const index = buildIndex(root);
const poly = analyseProject(index);
const graph = buildPolyglotGraph(poly);

describe("JPA relationships versus DDL keys", () => {
  it("reads the owning side of @ManyToOne / @OneToOne with explicit, composite and default join columns", () => {
    expect(
      (poly.java.relations ?? []).map(
        (r) =>
          `${r.type.split(".").pop()}.${r.field} @${r.kind} ${r.table}(${r.columns.join(",")})${r.implicit ? " implicit" : ""} -> ${r.target ?? `? ${r.unresolved}`}${r.referenced ? `(${r.referenced.join(",")})` : ""}`,
      ),
    ).toEqual([
      "Badge.emp @OneToOne BADGE(EMP_ID) implicit -> EMP",
      "Emp.dept @ManyToOne EMP(DEPT_ID) -> DEPT(ID)",
      "Emp.site @ManyToOne EMP(SITE_SITE_CODE) implicit -> SITE",
      "Emp.shift @ManyToOne EMP(SHIFT_PLANT,SHIFT_NO) -> SHIFT",
      "Emp.location @ManyToOne EMP(LOC_ID) -> ? Location",
    ]);
    // Join columns are the entity's columns; the inverse side (mappedBy) has none.
    const empCols = poly.java.columns.filter((c) => c.table === "EMP").map((c) => c.column);
    expect(empCols).toEqual([
      "ID",
      "DEPT_ID",
      "SITE_SITE_CODE",
      "SHIFT_PLANT",
      "SHIFT_NO",
      "LOC_ID",
    ]);
  });

  it("finds joins without a foreign key and foreign keys no mapping uses", () => {
    expect(
      compareJoinKeys(poly.java, poly.sql).map((f) =>
        f.kind === "join without foreign key"
          ? `${f.kind}: ${f.relation.type.split(".").pop()}.${f.relation.field} ${f.relation.table}(${f.relation.columns.join(",")})`
          : `${f.kind}: ${f.key.table}(${f.key.columns.join(",")}) -> ${f.key.target} ${f.key.file.split("/").pop()}:${f.key.line}`,
      ),
    ).toEqual([
      // SITE_SITE_CODE has no FK; BADGE is not in the DDL and LOC_ID's target is not an entity,
      // so neither is judged. AUDIT_LOG's FK is not reported: no entity maps AUDIT_LOG.
      "join without foreign key: Emp.site EMP(SITE_SITE_CODE)",
      "foreign key without mapping: EMP(MGR_ID) -> EMP plant.sql:11",
    ]);
  });

  it("puts JOIN edges between the tables and reaches them from impact", () => {
    expect(
      graph.edges
        .filter((e) => e.kind === "JOIN")
        .map((e) => `${e.from} -> ${e.to} | ${e.detail} | ${e.via}`),
    ).toEqual([
      "table:BADGE -> table:EMP | EMP_ID -> EMP (implicit name) | @OneToOne Badge.emp",
      "table:EMP -> table:DEPT | DEPT_ID -> DEPT(ID) | @ManyToOne Emp.dept",
      "table:EMP -> table:SHIFT | SHIFT_PLANT,SHIFT_NO -> SHIFT | @ManyToOne Emp.shift",
      "table:EMP -> table:SITE | SITE_SITE_CODE -> SITE (implicit name); no foreign key in the DDL | @ManyToOne Emp.site",
    ]);
    const dept = crossImpact(poly, graph, "table:DEPT");
    expect(dept?.schema.map((s) => `${s.relation}: ${s.node}`)).toContain(
      "JPA relationship joins to it: table:EMP",
    );
    const emp = crossImpact(poly, graph, "table:EMP");
    expect(emp?.schema.filter((s) => s.relation.startsWith("joins to")).map((s) => s.node)).toEqual(
      ["table:DEPT", "table:SHIFT", "table:SITE"],
    );
  });

  it("lists the relations and the key findings in the table definitions of the design document", () => {
    const section = (lang: "en" | "ja", title: string) => {
      const md = designDoc(index, { lang, poly }).markdown;
      const at = md.indexOf(title);
      expect(at).toBeGreaterThan(0);
      return md.slice(at, md.indexOf("\n#", at + 1));
    };
    const en = section("en", "JPA relationships and foreign keys");
    const row = (mapping: string) => en.split("\n").find((l) => l.startsWith(`| \`${mapping}`));
    expect(row("Emp.dept @ManyToOne")).toContain("| matches `db/plant.sql:6` |");
    expect(row("Emp.site @ManyToOne")).toContain("**none in the DDL (finding)**");
    expect(row("Emp.site @ManyToOne")).toContain("`EMP(SITE_SITE_CODE)` implicit");
    expect(row("Emp.shift @ManyToOne")).toContain("| matches `db/plant.sql:12` |");
    expect(row("Badge.emp @OneToOne")).toContain("not judged: table not in the analysed DDL");
    expect(row("Emp.location @ManyToOne")).toContain("| `Location` | not judged: target is not");
    expect(en).toContain("Foreign keys no mapping uses (finding):");
    expect(en).toContain("- `EMP(MGR_ID) -> EMP(ID)` `db/plant.sql:11`");
    expect(en).not.toContain("AUDIT_LOG");
    const ja = section("ja", "JPA リレーションと外部キー");
    expect(ja).toContain("**DDL に定義なし（指摘）**");
    expect(ja).toContain("どのマッピングも使わない外部キー（指摘）:");
  });
});
