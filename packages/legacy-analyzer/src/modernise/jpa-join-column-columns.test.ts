import { describe, expect, it } from "vitest";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE KILN (ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE BURNER (ID BIGINT PRIMARY KEY, KILN_REF BIGINT REFERENCES KILN(ID));
CREATE TABLE KILN_ALARMS (ALARM VARCHAR(40));
CREATE TABLE KILN_ZONES (KILN_ID BIGINT REFERENCES KILN(ID), ZONE VARCHAR(8));
`;

const domain = "src/main/java/jp/kazanami/plant/domain";
const java = (name: string, body: string) => ({
  [`${domain}/${name}.java`]: `package jp.kazanami.plant.domain;\n\n${body}`,
});

const root = namedTree("jpa-join-column-columns", {
  "db/plant.sql": DDL,
  ...java("Burner", `@Entity\npublic class Burner {\n  @Id\n  private Long id;\n}\n`),
  ...java(
    "Kiln",
    `@Entity
public class Kiln {
  @Id
  private Long id;
  private String name;
  @OneToMany
  @JoinColumn(name = "KILN_REF")
  private java.util.List<Burner> burners;
  @ElementCollection
  @CollectionTable(name = "KILN_ZONES", joinColumns = @JoinColumn(name = "KILN_ID"))
  @Column(name = "ZONE")
  private java.util.Set<String> zones;
  @ElementCollection
  @Column(name = "ALARM")
  private java.util.Set<String> alarms;
}
`,
  ),
});
const index = buildIndex(root);
const poly = analyseProject(index);

describe("JPA join-column and element collection join columns", () => {
  it("lists them as columns of the table holding the rows", () => {
    expect(
      poly.java.columns
        .filter((c) => ["burners", "zones", "alarms"].includes(c.field))
        .map((c) => `${c.field} ${c.table}.${c.column}${c.implicit ? " implicit" : ""}`)
        .toSorted(),
    ).toEqual([
      "alarms KILN_ALARMS.ALARM",
      "alarms KILN_ALARMS.KILN_ID implicit",
      "burners BURNER.KILN_REF",
      "zones KILN_ZONES.KILN_ID",
      "zones KILN_ZONES.ZONE",
    ]);
  });

  it("maps them on the graph and flags a join column the DDL does not have", () => {
    const graph = buildPolyglotGraph(poly);
    const missing = graph.nodes
      .filter((n) => n.kind === "column" && n.attrs?.defined === "not in the analysed DDL")
      .map((n) => `${n.attrs?.table}.${n.name}`);
    expect(missing).toEqual(["KILN_ALARMS.KILN_ID"]);
    const maps = graph.edges
      .filter((e) => e.kind === "MAPS" && e.detail?.startsWith("burners"))
      .map((e) => `${e.to} ${e.detail}`);
    expect(maps).toHaveLength(1);
  });
});
