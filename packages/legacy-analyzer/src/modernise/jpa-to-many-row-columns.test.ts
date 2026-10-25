import { describe, expect, it } from "vitest";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE LINE (ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE SHIFT (SHIFT_ID BIGINT PRIMARY KEY, CODE VARCHAR(4));
CREATE TABLE OPERATOR (ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE STATION (ID BIGINT PRIMARY KEY, LINE_ID BIGINT REFERENCES LINE(ID),
  STATIONS_KEY VARCHAR(8), SEQ INTEGER);
CREATE TABLE LINE_CREW (LINE_ID BIGINT REFERENCES LINE(ID), CREW_ID BIGINT
  REFERENCES OPERATOR(ID), ROLE VARCHAR(8));
CREATE TABLE LINE_LEADS (LINE_ID BIGINT REFERENCES LINE(ID), LEADS_ID BIGINT
  REFERENCES OPERATOR(ID), LEADS_KEY BIGINT REFERENCES SHIFT(SHIFT_ID));
CREATE TABLE LINE_BACKUPS (LINE_ID BIGINT REFERENCES LINE(ID), BACKUPS_ID BIGINT
  REFERENCES OPERATOR(ID));
`;

const domain = "src/main/java/jp/kazanami/plant/domain";
const java = (name: string, body: string) => ({
  [`${domain}/${name}.java`]: `package jp.kazanami.plant.domain;\n\n${body}`,
});

const root = namedTree("jpa-to-many-row-columns", {
  "db/plant.sql": DDL,
  ...java(
    "Shift",
    `@Entity\npublic class Shift {\n  @Id\n  @Column(name = "SHIFT_ID")\n  private Long id;\n  private String code;\n}\n`,
  ),
  ...java(
    "Operator",
    `@Entity\npublic class Operator {\n  @Id\n  private Long id;\n  private String name;\n}\n`,
  ),
  ...java("Station", `@Entity\npublic class Station {\n  @Id\n  private Long id;\n}\n`),
  ...java(
    "Line",
    `@Entity
public class Line {
  @Id
  private Long id;
  private String name;
  @OneToMany
  @JoinColumn(name = "LINE_ID")
  @OrderColumn(name = "SEQ")
  private java.util.Map<String, Station> stations;
  @ManyToMany
  @JoinTable(name = "LINE_CREW")
  @MapKeyColumn(name = "ROLE")
  private java.util.Map<String, Operator> crew;
  @ManyToMany
  @JoinTable(name = "LINE_LEADS")
  private java.util.Map<Shift, Operator> leads;
  @ManyToMany
  @JoinTable(name = "LINE_BACKUPS")
  @OrderColumn
  private java.util.List<Operator> backups;
}
`,
  ),
});
const index = buildIndex(root);
const poly = analyseProject(index);

describe("JPA to-many key and order columns", () => {
  it("maps a to-many Map's key and @OrderColumn on the table holding its rows", () => {
    expect(
      poly.java.columns
        .filter((c) => ["stations", "crew", "leads", "backups"].includes(c.field))
        .map((c) => `${c.field} ${c.table}.${c.column}${c.implicit ? " implicit" : ""}`)
        .toSorted(),
    ).toEqual([
      "backups LINE_BACKUPS.BACKUPS_ID implicit",
      "backups LINE_BACKUPS.BACKUPS_ORDER implicit",
      "backups LINE_BACKUPS.LINE_ID implicit",
      "crew LINE_CREW.CREW_ID implicit",
      "crew LINE_CREW.LINE_ID implicit",
      "crew LINE_CREW.ROLE",
      "leads LINE_LEADS.LEADS_ID implicit",
      "leads LINE_LEADS.LEADS_KEY implicit",
      "leads LINE_LEADS.LINE_ID implicit",
      "stations STATION.LINE_ID",
      "stations STATION.SEQ",
      "stations STATION.STATIONS_KEY implicit",
    ]);
  });

  it("keeps an entity-keyed to-many's MapKey relation", () => {
    expect(
      (poly.java.relations ?? [])
        .filter((r) => r.kind === "MapKey")
        .map((r) => `${r.field} ${r.table}(${r.columns.join(",")}) -> ${r.target}`),
    ).toEqual(["leads LINE_LEADS(LEADS_KEY) -> SHIFT"]);
  });

  it("flags a key or order column the DDL does not have", () => {
    const graph = buildPolyglotGraph(poly);
    const missing = graph.nodes
      .filter((n) => n.kind === "column" && n.attrs?.defined === "not in the analysed DDL")
      .map((n) => `${n.attrs?.table}.${n.name}`);
    expect(missing).toEqual(["LINE_BACKUPS.BACKUPS_ORDER"]);
  });
});
