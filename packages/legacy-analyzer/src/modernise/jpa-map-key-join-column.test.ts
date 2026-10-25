import { describe, expect, it } from "vitest";
import { designDoc } from "../design-doc.js";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { compareJoinKeys } from "./jpa-keys.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE LINE (ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE SHIFT (SHIFT_ID BIGINT PRIMARY KEY, CODE VARCHAR(4));
CREATE TABLE OPERATOR (ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE LINE_TARGETS (LINE_ID BIGINT REFERENCES LINE(ID),
  TARGETS_KEY BIGINT REFERENCES SHIFT(SHIFT_ID), TARGETS INTEGER);
CREATE TABLE LINE_ROSTER (LINE_ID BIGINT REFERENCES LINE(ID), ROSTER_ID BIGINT
  REFERENCES OPERATOR(ID), SHIFT_REF BIGINT);
`;

const domain = "src/main/java/jp/kazanami/plant/domain";
const java = (name: string, body: string) => ({
  [`${domain}/${name}.java`]: `package jp.kazanami.plant.domain;\n\n${body}`,
});

const root = namedTree("jpa-map-key-join-column", {
  "db/plant.sql": DDL,
  ...java(
    "Shift",
    `@Entity\npublic class Shift {\n  @Id\n  @Column(name = "SHIFT_ID")\n  private Long id;\n  private String code;\n}\n`,
  ),
  ...java(
    "Operator",
    `@Entity\npublic class Operator {\n  @Id\n  private Long id;\n  private String name;\n}\n`,
  ),
  ...java(
    "Line",
    `@Entity
public class Line {
  @Id
  private Long id;
  private String name;
  @ElementCollection
  private java.util.Map<Shift, Integer> targets;
  @ManyToMany
  @JoinTable(name = "LINE_ROSTER")
  @MapKeyJoinColumn(name = "SHIFT_REF", referencedColumnName = "SHIFT_ID")
  private java.util.Map<Shift, Operator> roster;
  @ElementCollection
  private java.util.Map<String, Integer> notes;
}
`,
  ),
});
const index = buildIndex(root);
const poly = analyseProject(index);
const short = (qn: string) => qn.split(".").pop();
const show = (r: NonNullable<typeof poly.java.relations>[number]) =>
  `${short(r.type)}.${r.field} @${r.kind} ${r.table}(${r.columns.join(",")})${r.referenced ? `->(${r.referenced.join(",")})` : ""}${r.implicit ? " implicit" : ""} -> ${r.target}`;

describe("JPA @MapKeyJoinColumn", () => {
  it("joins an entity-keyed map's rows to the key entity, named or JPA's default FIELD_KEY", () => {
    expect((poly.java.relations ?? []).filter((r) => r.kind === "MapKey").map(show)).toEqual([
      "Line.targets @MapKey LINE_TARGETS(TARGETS_KEY) implicit -> SHIFT",
      "Line.roster @MapKey LINE_ROSTER(SHIFT_REF)->(SHIFT_ID) -> SHIFT",
    ]);
  });

  it("maps the key join column on the collection table instead of a basic key column", () => {
    expect(
      poly.java.columns
        .filter((c) => c.field === "targets" || c.field === "notes")
        .map((c) => `${c.field} ${c.table}.${c.column}${c.implicit ? " implicit" : ""}`)
        .toSorted(),
    ).toEqual([
      "notes LINE_NOTES.LINE_ID implicit",
      "notes LINE_NOTES.NOTES implicit",
      "notes LINE_NOTES.NOTES_KEY implicit",
      "targets LINE_TARGETS.LINE_ID implicit",
      "targets LINE_TARGETS.TARGETS implicit",
      "targets LINE_TARGETS.TARGETS_KEY implicit",
    ]);
  });

  it("judges the key join against the DDL foreign keys", () => {
    const noKey = compareJoinKeys(poly.java, poly.sql).flatMap((f) =>
      f.kind === "join without foreign key" ? [`${f.relation.field} @${f.relation.kind}`] : [],
    );
    expect(noKey).toEqual(["roster @MapKey"]);
  });

  it("lists the key join in the design document", () => {
    const md = designDoc(index, { lang: "en", poly }).markdown;
    expect(md).toContain("Line.targets @MapKey");
    expect(md).toContain("Line.roster @MapKey");
  });
});
