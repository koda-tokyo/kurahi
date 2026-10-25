import { describe, expect, it } from "vitest";
import { designDoc } from "../design-doc.js";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { compareJoinKeys } from "./jpa-keys.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE SENSOR (ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE SENSOR_TAGS (SENSOR_ID BIGINT REFERENCES SENSOR(ID), TAGS VARCHAR(20));
CREATE TABLE SENSOR_LIMIT (SENSOR_REF BIGINT, LIMIT_NAME VARCHAR(20), LIMIT_VALUE DOUBLE);
CREATE TABLE SENSOR_CAL (SENSOR_ID BIGINT, SEQ INTEGER, LOW DOUBLE, CAL_HIGH DOUBLE,
  FOREIGN KEY (SENSOR_ID) REFERENCES SENSOR(ID));
`;

const domain = "src/main/java/jp/kazanami/plant/domain";
const java = (name: string, body: string) => ({
  [`${domain}/${name}.java`]: `package jp.kazanami.plant.domain;\n\n${body}`,
});

const root = namedTree("jpa-element-collection", {
  "db/plant.sql": DDL,
  ...java(
    "Range",
    `@Embeddable
public class Range {
  private Double low;
  private Double high;
}
`,
  ),
  ...java(
    "Sensor",
    `@Entity
public class Sensor {
  @Id
  private Long id;
  private String name;
  @ElementCollection
  private java.util.Set<String> tags;
  @ElementCollection
  @CollectionTable(name = "SENSOR_LIMIT", joinColumns = @JoinColumn(name = "SENSOR_REF"))
  @MapKeyColumn(name = "LIMIT_NAME")
  @Column(name = "LIMIT_VALUE")
  private java.util.Map<String, Double> limits;
  @ElementCollection
  @CollectionTable(name = "SENSOR_CAL")
  @OrderColumn(name = "SEQ")
  @AttributeOverride(name = "high", column = @Column(name = "CAL_HIGH"))
  private java.util.List<Range> calibrations;
}
`,
  ),
});
const index = buildIndex(root);
const poly = analyseProject(index);
const short = (qn: string) => qn.split(".").pop();

describe("JPA @ElementCollection", () => {
  it("maps each collection table, named or JPA's default ENTITY_FIELD", () => {
    expect(
      poly.java.tableUses
        .filter((u) => u.kind === "entity")
        .map((u) => `${short(u.type)} ${u.table} ${u.via}`)
        .toSorted(),
    ).toEqual([
      "Sensor SENSOR @Entity (default name)",
      "Sensor SENSOR_CAL @CollectionTable",
      "Sensor SENSOR_LIMIT @CollectionTable",
      "Sensor SENSOR_TAGS @ElementCollection (default name)",
    ]);
  });

  it("maps value, map key, order and embeddable columns on the collection table", () => {
    expect(
      poly.java.columns
        .map((c) => `${c.field} ${c.table}.${c.column}${c.implicit ? " implicit" : ""}`)
        .toSorted(),
    ).toEqual([
      "calibrations SENSOR_CAL.SENSOR_ID implicit",
      "calibrations SENSOR_CAL.SEQ",
      "calibrations.high SENSOR_CAL.CAL_HIGH",
      "calibrations.low SENSOR_CAL.LOW implicit",
      "id SENSOR.ID implicit",
      "limits SENSOR_LIMIT.LIMIT_NAME",
      "limits SENSOR_LIMIT.LIMIT_VALUE",
      "limits SENSOR_LIMIT.SENSOR_REF",
      "name SENSOR.NAME implicit",
      "tags SENSOR_TAGS.SENSOR_ID implicit",
      "tags SENSOR_TAGS.TAGS implicit",
    ]);
  });

  it("joins each collection table to the entity's and judges the join against the DDL", () => {
    expect(
      (poly.java.relations ?? []).map(
        (r) =>
          `${short(r.type)}.${r.field} @${r.kind} ${r.table}(${r.columns.join(",")})${r.implicit ? " implicit" : ""} -> ${r.target}`,
      ),
    ).toEqual([
      "Sensor.tags @ElementCollection SENSOR_TAGS(SENSOR_ID) implicit -> SENSOR",
      "Sensor.limits @ElementCollection SENSOR_LIMIT(SENSOR_REF) -> SENSOR",
      "Sensor.calibrations @ElementCollection SENSOR_CAL(SENSOR_ID) implicit -> SENSOR",
    ]);
    expect(
      compareJoinKeys(poly.java, poly.sql).map((f) =>
        f.kind === "join without foreign key" ? `${f.kind} ${f.relation.field}` : f.kind,
      ),
    ).toEqual(["join without foreign key limits"]);
  });

  it("lists the collection table's columns and its join in the design document", () => {
    const md = designDoc(index, { lang: "en", poly }).markdown;
    const row = (field: string) => md.split("\n").find((l) => l.startsWith(`| \`${field}\` |`));
    expect(row("limits")).toContain("`SENSOR_LIMIT.LIMIT_VALUE`");
    expect(row("calibrations")).toContain("`SENSOR_CAL.CAL_HIGH`");
    expect(md).toContain("Sensor.limits @ElementCollection");
    expect(md).not.toContain("SENSOR.TAGS");
  });
});
