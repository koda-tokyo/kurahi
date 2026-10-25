import { describe, expect, it } from "vitest";
import { designDoc } from "../design-doc.js";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE FURNACE (ID BIGINT PRIMARY KEY, STATE VARCHAR(12), MODE VARCHAR(12),
  PHASE INTEGER, LAST_FIRED DATE, SHIFT_START INTEGER, SERIAL_NO VARCHAR(20),
  GRADE VARCHAR(8), CHECKED TIMESTAMP);
CREATE TABLE FURNACE_ALARMS (FURNACE_ID BIGINT REFERENCES FURNACE(ID), ALARMS INTEGER);
`;

const domain = "src/main/java/jp/kazanami/plant/domain";
const java = (name: string, body: string) => ({
  [`${domain}/${name}.java`]: `package jp.kazanami.plant.domain;\n\n${body}`,
});

const root = namedTree("jpa-basic-storage", {
  "db/plant.sql": DDL,
  ...java("FurnaceState", `public enum FurnaceState {\n  HOT,\n  COLD\n}\n`),
  ...java("Grade", `public enum Grade {\n  A,\n  B\n}\n`),
  ...java(
    "Spec",
    `@Embeddable
public class Spec {
  @Enumerated(EnumType.STRING)
  private Grade grade;
  @Temporal(TemporalType.TIMESTAMP)
  private java.util.Date checked;
}
`,
  ),
  ...java(
    "Furnace",
    `@Entity
public class Furnace {
  @Id
  private Long id;
  @Enumerated(EnumType.STRING)
  private FurnaceState state;
  @Enumerated
  private FurnaceState mode;
  private FurnaceState phase;
  @Temporal(TemporalType.DATE)
  private java.util.Date lastFired;
  @Temporal(TemporalType.TIME)
  private java.util.Date shiftStart;
  private String serialNo;
  @Embedded
  private Spec spec;
  @ElementCollection
  @Enumerated(EnumType.STRING)
  private java.util.Set<FurnaceState> alarms;
}
`,
  ),
});
const index = buildIndex(root);
const poly = analyseProject(index);

describe("JPA @Enumerated / @Temporal on basic fields", () => {
  it("records how each basic column stores its value", () => {
    expect(
      poly.java.columns
        .filter((c) => c.type.endsWith(".Furnace"))
        .map((c) => `${c.field} ${c.table}.${c.column} ${c.stores ?? "-"}`),
    ).toEqual([
      "id FURNACE.ID -",
      "state FURNACE.STATE STRING",
      "mode FURNACE.MODE ORDINAL",
      "phase FURNACE.PHASE ORDINAL",
      "lastFired FURNACE.LAST_FIRED DATE",
      "shiftStart FURNACE.SHIFT_START TIME",
      "serialNo FURNACE.SERIAL_NO -",
      "alarms FURNACE_ALARMS.FURNACE_ID -",
      "alarms FURNACE_ALARMS.ALARMS STRING",
      "spec.grade FURNACE.GRADE STRING",
      "spec.checked FURNACE.CHECKED TIMESTAMP",
    ]);
  });

  it("flags a column whose DDL type cannot hold the storage on the MAPS edge", () => {
    const maps = buildPolyglotGraph(poly)
      .edges.filter((e) => e.kind === "MAPS" && e.detail?.includes("stored as"))
      .map((e) => `${e.to} ${e.detail}`);
    expect(maps).toEqual([
      "column:FURNACE.CHECKED spec.checked (implicit name); stored as TIMESTAMP",
      "column:FURNACE.GRADE spec.grade (implicit name); stored as STRING",
      "column:FURNACE.LAST_FIRED lastFired (implicit name); stored as DATE",
      "column:FURNACE.MODE mode (implicit name); stored as ORDINAL; DDL type VARCHAR(12) does not hold it",
      "column:FURNACE.PHASE phase (implicit name); stored as ORDINAL",
      "column:FURNACE.SHIFT_START shiftStart (implicit name); stored as TIME; DDL type INTEGER does not hold it",
      "column:FURNACE.STATE state (implicit name); stored as STRING",
      "column:FURNACE_ALARMS.ALARMS alarms (implicit name); stored as STRING; DDL type INTEGER does not hold it",
    ]);
  });

  it("shows the storage in the design document's field table", () => {
    const doc = designDoc(index, { lang: "en", poly }).markdown;
    expect(doc).toContain("`FURNACE.STATE` (implicit) `STRING`");
    expect(doc).toContain("`FURNACE.SHIFT_START` (implicit) `TIME`");
  });
});
