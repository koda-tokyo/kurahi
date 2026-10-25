import { describe, expect, it } from "vitest";
import { designDoc } from "../design-doc.js";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { compareJoinKeys } from "./jpa-keys.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE SITE (SITE_ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE SENSOR (ID BIGINT PRIMARY KEY, BUILDING VARCHAR(20), FLOOR_NO INTEGER,
  SITE_ID BIGINT REFERENCES SITE(SITE_ID), CALIBRATED_ON DATE, LOW DOUBLE, CAL_HIGH DOUBLE,
  ALARM_LOW DOUBLE, ALARM_HIGH DOUBLE);
CREATE TABLE READING (SENSOR_ID BIGINT, TAKEN_AT TIMESTAMP, VALUE DOUBLE,
  PRIMARY KEY (SENSOR_ID, TAKEN_AT));
`;

const domain = "src/main/java/jp/kazanami/plant/domain";
const java = (name: string, body: string) => ({
  [`${domain}/${name}.java`]: `package jp.kazanami.plant.domain;\n\n${body}`,
});

const root = namedTree("jpa-embedded", {
  "db/plant.sql": DDL,
  ...java(
    "Site",
    `@Entity
public class Site {
  @Id
  @Column(name = "SITE_ID")
  private Long id;
  private String name;
}
`,
  ),
  ...java(
    "Location",
    `@Embeddable
public class Location {
  private String building;
  @Column(name = "FLOOR_NO")
  private Integer floor;
  @ManyToOne
  @JoinColumn(name = "SITE_ID")
  private Site site;
}
`,
  ),
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
    "Calibration",
    `@Embeddable
public class Calibration {
  private java.time.LocalDate calibratedOn;
  @Embedded
  private Range range;
}
`,
  ),
  ...java(
    "Sensor",
    `@Entity
@AttributeOverride(name = "calibration.range.high", column = @Column(name = "CAL_HIGH"))
public class Sensor {
  @Id
  private Long id;
  @Embedded
  private Location location;
  private Calibration calibration;
  @Embedded
  @AttributeOverrides({
    @AttributeOverride(name = "low", column = @Column(name = "ALARM_LOW")),
    @AttributeOverride(name = "high", column = @Column(name = "ALARM_HIGH"))
  })
  private Range alarm;
}
`,
  ),
  ...java(
    "ReadingKey",
    `@Embeddable
public class ReadingKey implements java.io.Serializable {
  private Long sensorId;
  private java.time.Instant takenAt;
}
`,
  ),
  ...java(
    "Reading",
    `@Entity
public class Reading {
  @EmbeddedId
  private ReadingKey key;
  private Double value;
}
`,
  ),
});
const index = buildIndex(root);
const poly = analyseProject(index);
const short = (qn: string) => qn.split(".").pop();
const cols = (type: string) =>
  poly.java.columns
    .filter((c) => short(c.type) === type)
    .map((c) => `${c.field} ${c.table}.${c.column}${c.implicit ? " implicit" : ""}`)
    .toSorted();

describe("JPA @Embedded / @Embeddable", () => {
  it("maps no table for an embeddable", () => {
    expect(
      poly.java.tableUses
        .filter((u) => u.kind === "entity")
        .map((u) => `${short(u.type)} ${u.table}`)
        .toSorted(),
    ).toEqual(["Reading READING", "Sensor SENSOR", "Site SITE"]);
  });

  it("maps an embeddable's fields on the owner's table, nested and overridden by path", () => {
    expect(cols("Sensor")).toEqual([
      "alarm.high SENSOR.ALARM_HIGH",
      "alarm.low SENSOR.ALARM_LOW",
      "calibration.calibratedOn SENSOR.CALIBRATED_ON implicit",
      "calibration.range.high SENSOR.CAL_HIGH",
      "calibration.range.low SENSOR.LOW implicit",
      "id SENSOR.ID implicit",
      "location.building SENSOR.BUILDING implicit",
      "location.floor SENSOR.FLOOR_NO",
      "location.site SENSOR.SITE_ID",
    ]);
  });

  it("maps an @EmbeddedId's fields as the entity's key columns", () => {
    expect(cols("Reading")).toEqual([
      "key.sensorId READING.SENSOR_ID implicit",
      "key.takenAt READING.TAKEN_AT implicit",
      "value READING.VALUE implicit",
    ]);
  });

  it("owns an embeddable's to-one relation on the entity's table and judges it against the DDL", () => {
    expect(
      (poly.java.relations ?? []).map(
        (r) =>
          `${short(r.type)}.${r.field} @${r.kind} ${r.table}(${r.columns.join(",")}) -> ${r.target}`,
      ),
    ).toEqual(["Sensor.location.site @ManyToOne SENSOR(SITE_ID) -> SITE"]);
    expect(compareJoinKeys(poly.java, poly.sql)).toEqual([]);
  });

  it("lists every column of an embedded field in the design document", () => {
    const md = designDoc(index, { lang: "en", poly }).markdown;
    const row = (field: string) => md.split("\n").find((l) => l.startsWith(`| \`${field}\` |`));
    expect(row("location")).toContain("`SENSOR.BUILDING`");
    expect(row("location")).toContain("`SENSOR.FLOOR_NO`");
    expect(row("location")).toContain("`SENSOR.SITE_ID`");
    expect(row("alarm")).toContain("`SENSOR.ALARM_LOW`");
    expect(md).not.toContain("SENSOR.LOCATION");
  });
});
