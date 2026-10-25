import { describe, expect, it } from "vitest";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { compareJoinKeys } from "./jpa-keys.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE LINE (ID BIGINT PRIMARY KEY);
CREATE TABLE TOOL (TOOL_NO INT PRIMARY KEY);
CREATE TABLE STEP (ID BIGINT PRIMARY KEY, LINE_ID BIGINT REFERENCES LINE(ID), ROUTE_ID BIGINT);
CREATE TABLE LINE_TOOL (
  LINES_ID BIGINT REFERENCES LINE(ID),
  TOOLS_TOOL_NO INT REFERENCES TOOL(TOOL_NO),
  OLD_LINE_ID BIGINT REFERENCES LINE(ID)
);
CREATE TABLE OPS.CREW_SKILL (CREW_ID BIGINT, SKILL_ID BIGINT, NOTE_ID BIGINT);
`;

const entity = (name: string, table: string, body: string) => `package jp.kazanami.plant.domain;

@Entity
@Table(name = "${table}")
public class ${name} {
${body}
}
`;
const file = (n: string) => `src/main/java/jp/kazanami/plant/domain/${n}.java`;

const root = namedTree("jpa-many", {
  "db/plant.sql": DDL,
  [file("Tool")]: entity(
    "Tool",
    "TOOL",
    '  @Id\n  @Column(name = "TOOL_NO")\n  private Integer no;\n  @ManyToMany(mappedBy = "tools")\n  private Set<Line> lines;',
  ),
  [file("Step")]: entity("Step", "STEP", "  @Id\n  private Long id;"),
  [file("Skill")]: entity("Skill", "SKILL", "  @Id\n  private Long id;"),
  [file("Crew")]: entity(
    "Crew",
    "CREW",
    [
      "  @Id",
      "  private Long id;",
      "  @ManyToMany",
      '  @JoinTable(name = "CREW_SKILL", schema = "OPS",',
      '    joinColumns = @JoinColumn(name = "CREW_ID"),',
      '    inverseJoinColumns = { @JoinColumn(name = "SKILL_ID", referencedColumnName = "ID") })',
      "  private List<Skill> skills;",
    ].join("\n"),
  ),
  [file("Line")]: entity(
    "Line",
    "LINE",
    [
      "  @Id",
      "  private Long id;",
      "  @ManyToMany",
      "  private Set<Tool> tools;",
      "  @OneToMany",
      '  @JoinColumn(name = "LINE_ID")',
      "  private List<Step> steps;",
      "  @OneToMany(targetEntity = Step.class)",
      '  @JoinColumn(name = "ROUTE_ID")',
      "  private List<Object> route;",
      '  @OneToMany(mappedBy = "line")',
      "  private List<Step> inverse;",
      "  @OneToMany",
      "  private Map<String, Skill> skillsByCode;",
    ].join("\n"),
  ),
});
const poly = analyseProject(buildIndex(root));
const graph = buildPolyglotGraph(poly);

describe("JPA to-many relationships versus DDL keys", () => {
  it("reads join tables, @OneToMany join columns and JPA's default names; mappedBy sides have none", () => {
    expect(
      (poly.java.relations ?? []).map(
        (r) =>
          `${r.type.split(".").pop()}.${r.field} @${r.kind} ${r.schema ? `${r.schema}.` : ""}${r.table}(${r.columns.join(",")})${r.implicit ? " implicit" : ""}${r.joinTable ? " jt" : ""} -> ${r.target ?? `? ${r.unresolved}`}${r.referenced ? `(${r.referenced.join(",")})` : ""}`,
      ),
    ).toEqual([
      "Crew.skills @ManyToMany OPS.CREW_SKILL(CREW_ID) jt -> CREW",
      "Crew.skills @ManyToMany OPS.CREW_SKILL(SKILL_ID) jt -> SKILL(ID)",
      // Bidirectional: the owner-side default column is the inverse field + the owner's @Id.
      "Line.tools @ManyToMany LINE_TOOL(LINES_ID) implicit jt -> LINE",
      "Line.tools @ManyToMany LINE_TOOL(TOOLS_TOOL_NO) implicit jt -> TOOL",
      "Line.steps @OneToMany STEP(LINE_ID) -> LINE",
      "Line.route @OneToMany STEP(ROUTE_ID) -> LINE",
      // A @OneToMany with no join column has a join table; the map's value type is the target.
      "Line.skillsByCode @OneToMany LINE_SKILL(LINE_ID) implicit jt -> LINE",
      "Line.skillsByCode @OneToMany LINE_SKILL(SKILLS_BY_CODE_ID) implicit jt -> SKILL",
    ]);
    // A collection is no column of the owner's table.
    expect(poly.java.columns.filter((c) => c.table === "LINE").map((c) => c.column)).toEqual([
      "ID",
    ]);
  });

  it("compares join-table and @OneToMany join columns with the DDL's foreign keys", () => {
    expect(
      compareJoinKeys(poly.java, poly.sql).map((f) =>
        f.kind === "join without foreign key"
          ? `${f.kind}: ${f.relation.type.split(".").pop()}.${f.relation.field} ${f.relation.table}(${f.relation.columns.join(",")})`
          : `${f.kind}: ${f.key.table}(${f.key.columns.join(",")}) -> ${f.key.target}`,
      ),
    ).toEqual([
      // CREW_SKILL has no FKs; LINE_TOOL's default columns and STEP.LINE_ID match their keys, and
      // the join table's OLD_LINE_ID key is one no mapping uses; LINE_SKILL is not in the DDL.
      "join without foreign key: Crew.skills CREW_SKILL(CREW_ID)",
      "join without foreign key: Crew.skills CREW_SKILL(SKILL_ID)",
      "join without foreign key: Line.route STEP(ROUTE_ID)",
      "foreign key without mapping: LINE_TOOL(OLD_LINE_ID) -> LINE",
    ]);
  });

  it("puts a join table between both sides in the graph", () => {
    expect(
      graph.edges
        .filter((e) => e.kind === "JOIN" && e.via?.includes("Crew"))
        .map((e) => `${e.from} -> ${e.to} | ${e.detail} | ${e.via}`),
    ).toEqual([
      "table:CREW_SKILL -> table:CREW | CREW_ID -> CREW (join table); no foreign key in the DDL | @ManyToMany Crew.skills",
      "table:CREW_SKILL -> table:SKILL | SKILL_ID -> SKILL(ID) (join table); no foreign key in the DDL | @ManyToMany Crew.skills",
    ]);
  });
});
