import { describe, expect, it } from "vitest";
import { designDoc } from "../design-doc.js";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE LINE (ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE LINE_BY_STATE (LINE_ID BIGINT REFERENCES LINE(ID), BY_STATE_KEY VARCHAR(12), BY_STATE INTEGER);
CREATE TABLE LINE_BY_ORDINAL (LINE_ID BIGINT REFERENCES LINE(ID), STATE_NO VARCHAR(12), BY_ORDINAL INTEGER);
CREATE TABLE LINE_BY_DAY (LINE_ID BIGINT REFERENCES LINE(ID), BY_DAY_KEY DATE, BY_DAY INTEGER);
CREATE TABLE LINE_BY_SHIFT (LINE_ID BIGINT REFERENCES LINE(ID), BY_SHIFT_KEY INTEGER, BY_SHIFT INTEGER);
`;

const domain = "src/main/java/jp/kazanami/plant/domain";
const java = (name: string, body: string) => ({
  [`${domain}/${name}.java`]: `package jp.kazanami.plant.domain;\n\n${body}`,
});

const root = namedTree("jpa-map-key-storage", {
  "db/plant.sql": DDL,
  ...java("LineState", `public enum LineState {\n  RUNNING,\n  STOPPED\n}\n`),
  ...java(
    "Line",
    `@Entity
public class Line {
  @Id
  private Long id;
  private String name;
  @ElementCollection
  @CollectionTable(name = "LINE_BY_STATE")
  @MapKeyEnumerated(EnumType.STRING)
  private java.util.Map<LineState, Integer> byState;
  @ElementCollection
  @CollectionTable(name = "LINE_BY_ORDINAL")
  @MapKeyColumn(name = "STATE_NO")
  private java.util.Map<LineState, Integer> byOrdinal;
  @ElementCollection
  @CollectionTable(name = "LINE_BY_DAY")
  @MapKeyTemporal(TemporalType.DATE)
  private java.util.Map<java.util.Date, Integer> byDay;
  @ElementCollection
  @CollectionTable(name = "LINE_BY_SHIFT")
  @MapKeyTemporal(TemporalType.TIME)
  private java.util.Map<java.util.Date, Integer> byShift;
  @ElementCollection
  @CollectionTable(name = "LINE_BY_NOTE")
  private java.util.Map<String, Integer> byNote;
}
`,
  ),
});
const index = buildIndex(root);
const poly = analyseProject(index);

describe("JPA @MapKeyEnumerated / @MapKeyTemporal", () => {
  it("records how each basic map key column stores the key", () => {
    expect(
      poly.java.columns
        .filter((c) => c.column.endsWith("_KEY") || c.column === "STATE_NO")
        .map((c) => `${c.field} ${c.table}.${c.column} ${c.stores ?? "-"}`),
    ).toEqual([
      "byState LINE_BY_STATE.BY_STATE_KEY STRING",
      "byOrdinal LINE_BY_ORDINAL.STATE_NO ORDINAL",
      "byDay LINE_BY_DAY.BY_DAY_KEY DATE",
      "byShift LINE_BY_SHIFT.BY_SHIFT_KEY TIME",
      "byNote LINE_BY_NOTE.BY_NOTE_KEY -",
    ]);
  });

  it("flags a key column whose DDL type cannot hold the storage on the MAPS edge", () => {
    const maps = buildPolyglotGraph(poly)
      .edges.filter((e) => e.kind === "MAPS" && e.detail?.includes("stored as"))
      .map((e) => `${e.to} ${e.detail}`);
    expect(maps).toEqual([
      "column:LINE_BY_DAY.BY_DAY_KEY byDay (implicit name); stored as DATE",
      "column:LINE_BY_ORDINAL.STATE_NO byOrdinal; stored as ORDINAL; DDL type VARCHAR(12) does not hold it",
      "column:LINE_BY_SHIFT.BY_SHIFT_KEY byShift (implicit name); stored as TIME; DDL type INTEGER does not hold it",
      "column:LINE_BY_STATE.BY_STATE_KEY byState (implicit name); stored as STRING",
    ]);
  });

  it("shows the storage in the design document's field table", () => {
    const doc = designDoc(index, { lang: "en", poly }).markdown;
    expect(doc).toContain("`LINE_BY_STATE.BY_STATE_KEY` (implicit) `STRING`");
    expect(doc).toContain("`LINE_BY_ORDINAL.STATE_NO` `ORDINAL`");
  });
});
