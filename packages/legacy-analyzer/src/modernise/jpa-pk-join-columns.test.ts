import { describe, expect, it } from "vitest";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE PRESS (ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE PRESS_SPEC (ID BIGINT PRIMARY KEY REFERENCES PRESS(ID), TONNAGE INTEGER);
CREATE TABLE PRESS_NOTE (NOTE VARCHAR(200));
CREATE TABLE SERVO_PRESS (PRESS_ID BIGINT PRIMARY KEY REFERENCES PRESS(ID), AXES INTEGER);
CREATE TABLE HYDRAULIC_PRESS (BAR INTEGER);
`;

const domain = "src/main/java/jp/kazanami/plant/domain";
const java = (name: string, body: string) => ({
  [`${domain}/${name}.java`]: `package jp.kazanami.plant.domain;\n\n${body}`,
});

const root = namedTree("jpa-pk-join-columns", {
  "db/plant.sql": DDL,
  ...java(
    "Press",
    `@Entity
@Inheritance(strategy = InheritanceType.JOINED)
@SecondaryTables({
  @SecondaryTable(name = "PRESS_SPEC"),
  @SecondaryTable(name = "PRESS_NOTE", pkJoinColumns = @PrimaryKeyJoinColumn(name = "PRESS_ID"))
})
public class Press {
  @Id
  private Long id;
  private String name;
  @Column(table = "PRESS_SPEC")
  private Integer tonnage;
  @Column(table = "PRESS_NOTE")
  private String note;
}
`,
  ),
  ...java(
    "ServoPress",
    `@Entity
@Table(name = "SERVO_PRESS")
@PrimaryKeyJoinColumn(name = "PRESS_ID")
public class ServoPress extends Press {
  private Integer axes;
}
`,
  ),
  ...java(
    "HydraulicPress",
    `@Entity
@Table(name = "HYDRAULIC_PRESS")
public class HydraulicPress extends Press {
  private Integer bar;
}
`,
  ),
});
const index = buildIndex(root);
const poly = analyseProject(index);

describe("JPA primary key join columns", () => {
  it("lists a secondary table's and a JOINED subclass's primary key join columns as its columns", () => {
    expect(
      poly.java.columns
        .filter((c) => c.primaryKeyJoin)
        .map(
          (c) =>
            `${c.type.split(".").pop()} ${c.table}.${c.column}${c.implicit ? " implicit" : ""}`,
        )
        .toSorted(),
    ).toEqual([
      "HydraulicPress HYDRAULIC_PRESS.ID implicit",
      "Press PRESS_NOTE.PRESS_ID",
      "Press PRESS_SPEC.ID implicit",
      "ServoPress SERVO_PRESS.PRESS_ID",
    ]);
    expect(poly.java.columns.filter((c) => c.primaryKeyJoin).every((c) => c.field === "")).toBe(
      true,
    );
  });

  it("maps them on the graph and flags a primary key join column the DDL does not have", () => {
    const graph = buildPolyglotGraph(poly);
    const missing = graph.nodes
      .filter((n) => n.kind === "column" && n.attrs?.defined === "not in the analysed DDL")
      .map((n) => `${n.attrs?.table}.${n.name}`)
      .toSorted();
    expect(missing).toEqual(["HYDRAULIC_PRESS.ID", "PRESS_NOTE.PRESS_ID"]);
    const maps = graph.edges
      .filter((e) => e.kind === "MAPS" && e.detail?.startsWith("primary key join column"))
      .map((e) => e.detail)
      .toSorted((a, b) => ((a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0));
    expect(maps).toEqual([
      "primary key join column",
      "primary key join column",
      "primary key join column (implicit name)",
      "primary key join column (implicit name)",
    ]);
  });
});
