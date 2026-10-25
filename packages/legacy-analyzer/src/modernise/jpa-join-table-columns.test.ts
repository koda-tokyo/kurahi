import { describe, expect, it } from "vitest";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE OPERATOR (ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE SKILL (ID BIGINT PRIMARY KEY, CODE VARCHAR(8));
CREATE TABLE LINE (ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE LINE_CREW (LINE_ID BIGINT REFERENCES LINE(ID), MEMBER_ID BIGINT
  REFERENCES OPERATOR(ID));
CREATE TABLE OPERATOR_SKILLS (OPERATOR_ID BIGINT REFERENCES OPERATOR(ID));
`;

const domain = "src/main/java/jp/kazanami/plant/domain";
const java = (name: string, body: string) => ({
  [`${domain}/${name}.java`]: `package jp.kazanami.plant.domain;\n\n${body}`,
});

const root = namedTree("jpa-join-table-columns", {
  "db/plant.sql": DDL,
  ...java(
    "Skill",
    `@Entity\npublic class Skill {\n  @Id\n  private Long id;\n  private String code;\n}\n`,
  ),
  ...java(
    "Operator",
    `@Entity
public class Operator {
  @Id
  private Long id;
  private String name;
  @ManyToMany
  @JoinTable(name = "OPERATOR_SKILLS")
  private java.util.Set<Skill> skills;
}
`,
  ),
  ...java(
    "Line",
    `@Entity
public class Line {
  @Id
  private Long id;
  private String name;
  @ManyToMany
  @JoinTable(name = "LINE_CREW",
    joinColumns = @JoinColumn(name = "LINE_ID"),
    inverseJoinColumns = @JoinColumn(name = "MEMBER_ID"))
  private java.util.List<Operator> crew;
}
`,
  ),
});
const index = buildIndex(root);
const poly = analyseProject(index);

describe("JPA join table join columns", () => {
  it("lists a join table's join and inverse join columns as its columns", () => {
    expect(
      poly.java.columns
        .filter((c) => ["crew", "skills"].includes(c.field))
        .map((c) => `${c.field} ${c.table}.${c.column}${c.implicit ? " implicit" : ""}`)
        .toSorted(),
    ).toEqual([
      "crew LINE_CREW.LINE_ID",
      "crew LINE_CREW.MEMBER_ID",
      "skills OPERATOR_SKILLS.OPERATOR_ID implicit",
      "skills OPERATOR_SKILLS.SKILLS_ID implicit",
    ]);
  });

  it("maps them on the graph and flags a join column the DDL does not have", () => {
    const graph = buildPolyglotGraph(poly);
    const missing = graph.nodes
      .filter((n) => n.kind === "column" && n.attrs?.defined === "not in the analysed DDL")
      .map((n) => `${n.attrs?.table}.${n.name}`);
    expect(missing).toEqual(["OPERATOR_SKILLS.SKILLS_ID"]);
    const maps = graph.edges
      .filter((e) => e.kind === "MAPS" && e.detail?.startsWith("crew"))
      .map((e) => `${e.to} ${e.detail}`);
    expect(maps).toHaveLength(2);
  });
});
