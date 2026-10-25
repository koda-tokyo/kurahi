import { describe, expect, it } from "vitest";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { compareJoinKeys } from "./jpa-keys.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE OPERATOR (ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE STEP (ID BIGINT PRIMARY KEY, NOTE VARCHAR(200), LINE_ID BIGINT);
CREATE TABLE LINE (ID BIGINT PRIMARY KEY);
CREATE TABLE CELL (ID BIGINT PRIMARY KEY);
CREATE TABLE LINE_CREW (LINE_ID BIGINT REFERENCES LINE(ID), MEMBER_ID BIGINT
  REFERENCES OPERATOR(ID));
CREATE TABLE LINE_ROUTE (LINE_ID BIGINT REFERENCES LINE(ID), STEP_ID BIGINT
  REFERENCES STEP(ID), SEQ INT);
CREATE TABLE CELL_OPERATOR (CREWED_ID BIGINT REFERENCES CELL(ID), CREW_ID BIGINT
  REFERENCES OPERATOR(ID));
`;

const domain = "src/main/java/jp/kazanami/plant/domain";
const java = (name: string, body: string) => ({
  [`${domain}/${name}.java`]: `package jp.kazanami.plant.domain;\n\n${body}`,
});

const root = namedTree("jpa-association-override-join-table", {
  "db/plant.sql": DDL,
  ...java(
    "Operator",
    `@Entity\npublic class Operator {\n  @Id\n  private Long id;\n  private String name;\n}\n`,
  ),
  ...java(
    "Step",
    `@Entity\npublic class Step {\n  @Id\n  private Long id;\n  private String note;\n}\n`,
  ),
  ...java(
    "Crewed",
    `@MappedSuperclass
public abstract class Crewed {
  @Id
  private Long id;
  @ManyToMany
  private List<Operator> crew;
  @OneToMany
  @JoinColumn(name = "LINE_ID")
  @OrderColumn(name = "SEQ")
  private List<Step> route;
}
`,
  ),
  ...java(
    "Line",
    `@Entity
@AssociationOverrides({
  @AssociationOverride(name = "crew",
    joinTable = @JoinTable(name = "LINE_CREW",
      joinColumns = @JoinColumn(name = "LINE_ID"),
      inverseJoinColumns = @JoinColumn(name = "MEMBER_ID", referencedColumnName = "ID"))),
  @AssociationOverride(name = "route",
    joinTable = @JoinTable(name = "LINE_ROUTE",
      joinColumns = @JoinColumn(name = "LINE_ID"),
      inverseJoinColumns = @JoinColumn(name = "STEP_ID")))
})
public class Line extends Crewed {
}
`,
  ),
  ...java("Cell", `@Entity\npublic class Cell extends Crewed {\n}\n`),
});
const index = buildIndex(root);
const poly = analyseProject(index);
const short = (qn: string) => qn.split(".").pop();
const rels = (type: string) =>
  (poly.java.relations ?? [])
    .filter((r) => short(r.type) === type)
    .map(
      (r) =>
        `${r.kind} ${r.field} ${r.table}(${r.columns.join(",")})${r.referenced ? `=${r.referenced.join(",")}` : ""}${r.implicit ? " implicit" : ""} -> ${r.target ?? `?${r.unresolved}`}`,
    )
    .toSorted();

describe("JPA @AssociationOverride joinTable", () => {
  it("replaces a mapped superclass's to-many join table on the overriding entity", () => {
    expect(rels("Line")).toEqual([
      "ManyToMany crew LINE_CREW(LINE_ID) -> LINE",
      "ManyToMany crew LINE_CREW(MEMBER_ID)=ID -> OPERATOR",
      "OneToMany route LINE_ROUTE(LINE_ID) -> LINE",
      "OneToMany route LINE_ROUTE(STEP_ID) -> STEP",
    ]);
  });

  it("leaves the mapping as declared on an entity without the override", () => {
    expect(rels("Cell")).toEqual([
      "ManyToMany crew CELL_OPERATOR(CELL_ID) implicit -> CELL",
      "ManyToMany crew CELL_OPERATOR(CREW_ID) implicit -> OPERATOR",
      "OneToMany route STEP(LINE_ID) -> CELL",
    ]);
  });

  it("puts the join and order columns on the overriding join table", () => {
    expect(
      poly.java.columns
        .filter((c) => c.field === "route")
        .map((c) => `${short(c.type)} ${c.table}.${c.column}`)
        .toSorted(),
    ).toEqual([
      "Cell STEP.LINE_ID",
      "Cell STEP.SEQ",
      "Line LINE_ROUTE.LINE_ID",
      "Line LINE_ROUTE.SEQ",
      "Line LINE_ROUTE.STEP_ID",
    ]);
  });

  it("judges the overridden join table against the DDL keys", () => {
    expect(
      compareJoinKeys(poly.java, poly.sql).map((f) =>
        f.kind === "join without foreign key"
          ? `${f.kind}: ${f.relation.table}(${f.relation.columns.join(",")})`
          : `${f.kind}: ${f.key.table}(${f.key.columns.join(",")})`,
      ),
    ).toEqual([
      "join without foreign key: CELL_OPERATOR(CELL_ID)",
      "join without foreign key: STEP(LINE_ID)",
      "foreign key without mapping: CELL_OPERATOR(CREWED_ID)",
    ]);
  });
});
