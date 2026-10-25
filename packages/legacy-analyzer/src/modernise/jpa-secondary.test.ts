import { describe, expect, it } from "vitest";
import { designDoc } from "../design-doc.js";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { compareJoinKeys } from "./jpa-keys.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE LINE (ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE LINE_SPEC (ID BIGINT PRIMARY KEY REFERENCES LINE(ID), RATED_SPEED INTEGER);
CREATE TABLE LINE_NOTE (LINE_ID BIGINT PRIMARY KEY, NOTE VARCHAR(200));
CREATE TABLE CELL (CELL_ID BIGINT PRIMARY KEY);
CREATE TABLE CELL_EXT (CID BIGINT PRIMARY KEY REFERENCES CELL(CELL_ID), LINE_ID BIGINT REFERENCES LINE(ID));
`;

const root = namedTree("jpa-secondary", {
  "db/plant.sql": DDL,
  "src/main/java/jp/kazanami/plant/domain/Line.java": `package jp.kazanami.plant.domain;

@Entity
@Table(name = "LINE")
@SecondaryTables({
  @SecondaryTable(name = "LINE_SPEC"),
  @SecondaryTable(name = "LINE_NOTE", pkJoinColumns = @PrimaryKeyJoinColumn(name = "LINE_ID"))
})
public class Line {
  @Id
  private Long id;
  private String name;
  @Column(name = "RATED_SPEED", table = "LINE_SPEC")
  private Integer ratedSpeed;
  @Column(table = "LINE_NOTE")
  private String note;
}
`,
  "src/main/java/jp/kazanami/plant/domain/Cell.java": `package jp.kazanami.plant.domain;

@Entity
@Table(name = "CELL")
@SecondaryTable(name = "CELL_EXT", pkJoinColumns = {
  @PrimaryKeyJoinColumn(name = "CID", referencedColumnName = "CELL_ID")
})
public class Cell {
  @Id
  @Column(name = "CELL_ID")
  private Long id;
  @ManyToOne
  @JoinColumn(name = "LINE_ID", table = "CELL_EXT")
  private Line line;
}
`,
});
const index = buildIndex(root);
const poly = analyseProject(index);
const graph = buildPolyglotGraph(poly);

describe("JPA secondary tables", () => {
  it("maps @SecondaryTable / @SecondaryTables as entity tables joined to the primary on the primary key join columns", () => {
    expect(
      poly.java.tableUses
        .filter((u) => u.kind === "entity")
        .map((u) => `${u.type.split(".").pop()} ${u.table} ${u.via}`),
    ).toEqual([
      "Cell CELL @Table",
      "Cell CELL_EXT @SecondaryTable",
      "Line LINE @Table",
      "Line LINE_SPEC @SecondaryTable",
      "Line LINE_NOTE @SecondaryTable",
    ]);
    expect(
      (poly.java.relations ?? []).map(
        (r) =>
          `${r.type.split(".").pop()}${r.field ? `.${r.field}` : ""} @${r.kind} ${r.table}(${r.columns.join(",")})${r.implicit ? " implicit" : ""} -> ${r.target}${r.referenced ? `(${r.referenced.join(",")})` : ""}`,
      ),
    ).toEqual([
      "Cell @SecondaryTable CELL_EXT(CID) -> CELL(CELL_ID)",
      "Cell.line @ManyToOne CELL_EXT(LINE_ID) -> LINE",
      "Line @SecondaryTable LINE_SPEC(ID) implicit -> LINE",
      "Line @SecondaryTable LINE_NOTE(LINE_ID) -> LINE",
    ]);
  });

  it("puts a column annotated with table = on the secondary table", () => {
    expect(poly.java.columns.map((c) => `${c.field} ${c.table}.${c.column}`)).toEqual([
      " CELL_EXT.CID",
      "id CELL.CELL_ID",
      "line CELL_EXT.LINE_ID",
      " LINE_SPEC.ID",
      " LINE_NOTE.LINE_ID",
      "id LINE.ID",
      "name LINE.NAME",
      "ratedSpeed LINE_SPEC.RATED_SPEED",
      "note LINE_NOTE.NOTE",
    ]);
  });

  it("judges the secondary table's join against the DDL keys and draws JOIN edges", () => {
    expect(
      compareJoinKeys(poly.java, poly.sql).map((f) =>
        f.kind === "join without foreign key"
          ? `${f.kind}: ${f.relation.table}(${f.relation.columns.join(",")})`
          : `${f.kind}: ${f.key.table}(${f.key.columns.join(",")})`,
      ),
    ).toEqual(["join without foreign key: LINE_NOTE(LINE_ID)"]);
    expect(
      graph.edges.filter((e) => e.kind === "JOIN").map((e) => `${e.from} -> ${e.to} | ${e.via}`),
    ).toEqual([
      "table:CELL_EXT -> table:CELL | @SecondaryTable Cell",
      "table:CELL_EXT -> table:LINE | @ManyToOne Cell.line",
      "table:LINE_NOTE -> table:LINE | @SecondaryTable Line",
      "table:LINE_SPEC -> table:LINE | @SecondaryTable Line",
    ]);
  });

  it("lists the secondary tables in the design document's relationships", () => {
    const md = designDoc(index, { lang: "en", poly }).markdown;
    const at = md.indexOf("JPA relationships and foreign keys");
    const en = md.slice(at, md.indexOf("\n#", at + 1));
    const row = (mapping: string) => en.split("\n").find((l) => l.startsWith(`| \`${mapping}`));
    expect(row("Line @SecondaryTable")).toBeDefined();
    expect(en).toContain("**none in the DDL (finding)**");
    expect(en).not.toContain("Foreign keys no mapping uses");
  });
});
