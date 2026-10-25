import { describe, expect, it } from "vitest";
import { designDoc } from "../design-doc.js";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { compareJoinKeys } from "./jpa-keys.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE EQUIPMENT (EQ_ID BIGINT PRIMARY KEY, EQ_TYPE VARCHAR(8), TAG VARCHAR(20), FLOW_RATE INTEGER);
CREATE TABLE SENSOR (ID BIGINT PRIMARY KEY, PUMP_EQ_ID BIGINT REFERENCES EQUIPMENT(EQ_ID));
CREATE TABLE WORK_ORDER (ORDER_ID BIGINT PRIMARY KEY, TITLE VARCHAR(80));
CREATE TABLE REPAIR_ORDER (ORDER_ID BIGINT PRIMARY KEY REFERENCES WORK_ORDER(ORDER_ID), PART VARCHAR(40));
CREATE TABLE INSPECTION_ORDER (INSP_ID BIGINT PRIMARY KEY, RESULT VARCHAR(20));
CREATE TABLE TEMP_READING (ID BIGINT PRIMARY KEY, TAKEN_AT TIMESTAMP, CELSIUS NUMERIC(5,1));
`;

const domain = "src/main/java/jp/kazanami/plant/domain";
const java = (name: string, body: string) => ({
  [`${domain}/${name}.java`]: `package jp.kazanami.plant.domain;\n\n${body}`,
});

const root = namedTree("jpa-inheritance", {
  "db/plant.sql": DDL,
  ...java(
    "Equipment",
    `@Entity
@Table(name = "EQUIPMENT")
@DiscriminatorColumn(name = "EQ_TYPE")
public class Equipment {
  @Id
  @Column(name = "EQ_ID")
  private Long id;
  private String tag;
}
`,
  ),
  ...java(
    "Pump",
    `@Entity
@Table(name = "PUMP")
public class Pump extends Equipment {
  private Integer flowRate;
}
`,
  ),
  ...java(
    "Sensor",
    `@Entity
public class Sensor {
  @Id
  private Long id;
  @ManyToOne
  private Pump pump;
}
`,
  ),
  ...java(
    "WorkOrder",
    `@Entity
@Inheritance(strategy = InheritanceType.JOINED)
@Table(name = "WORK_ORDER")
public class WorkOrder {
  @Id
  @Column(name = "ORDER_ID")
  private Long id;
  private String title;
}
`,
  ),
  ...java(
    "RepairOrder",
    `@Entity
@Table(name = "REPAIR_ORDER")
public class RepairOrder extends WorkOrder {
  private String part;
}
`,
  ),
  ...java(
    "InspectionOrder",
    `@Entity
@Table(name = "INSPECTION_ORDER")
@PrimaryKeyJoinColumn(name = "INSP_ID", referencedColumnName = "ORDER_ID")
public class InspectionOrder extends WorkOrder {
  private String result;
}
`,
  ),
  ...java(
    "Reading",
    `@Entity
@Inheritance(strategy = InheritanceType.TABLE_PER_CLASS)
public class Reading {
  @Id
  private Long id;
  private java.time.Instant takenAt;
}
`,
  ),
  ...java(
    "TempReading",
    `@Entity
@Table(name = "TEMP_READING")
public class TempReading extends Reading {
  private java.math.BigDecimal celsius;
}
`,
  ),
});
const index = buildIndex(root);
const poly = analyseProject(index);
const graph = buildPolyglotGraph(poly);
const short = (qn: string) => qn.split(".").pop();

describe("JPA inheritance", () => {
  it("maps each strategy's entity tables: SINGLE_TABLE subclasses on the root's table, JOINED and TABLE_PER_CLASS on their own", () => {
    expect(
      poly.java.tableUses
        .filter((u) => u.kind === "entity")
        .map((u) => `${short(u.type)} ${u.table} ${u.via}`)
        .toSorted(),
    ).toEqual([
      "Equipment EQUIPMENT @Table",
      "InspectionOrder INSPECTION_ORDER @Table",
      "Pump EQUIPMENT @Inheritance(SINGLE_TABLE) Equipment",
      "Reading READING @Entity (default name)",
      "RepairOrder REPAIR_ORDER @Table",
      "Sensor SENSOR @Entity (default name)",
      "TempReading TEMP_READING @Table",
      "WorkOrder WORK_ORDER @Table",
    ]);
  });

  it("maps columns: the discriminator, subclass fields, and inherited fields copied for TABLE_PER_CLASS", () => {
    expect(
      poly.java.columns.map(
        (c) =>
          `${short(c.type)} ${c.discriminator ? "(discriminator)" : c.field} ${c.table}.${c.column}${c.implicit ? " implicit" : ""}`,
      ),
    ).toEqual([
      "Equipment (discriminator) EQUIPMENT.EQ_TYPE",
      "Equipment id EQUIPMENT.EQ_ID",
      "Equipment tag EQUIPMENT.TAG implicit",
      "InspectionOrder  INSPECTION_ORDER.INSP_ID",
      "InspectionOrder result INSPECTION_ORDER.RESULT implicit",
      "Pump flowRate EQUIPMENT.FLOW_RATE implicit",
      "Reading id READING.ID implicit",
      "TempReading id TEMP_READING.ID implicit",
      "Reading takenAt READING.TAKEN_AT implicit",
      "TempReading takenAt TEMP_READING.TAKEN_AT implicit",
      "RepairOrder  REPAIR_ORDER.ORDER_ID implicit",
      "RepairOrder part REPAIR_ORDER.PART implicit",
      "Sensor id SENSOR.ID implicit",
      "Sensor pump SENSOR.PUMP_EQ_ID implicit",
      "TempReading celsius TEMP_READING.CELSIUS implicit",
      "WorkOrder id WORK_ORDER.ORDER_ID",
      "WorkOrder title WORK_ORDER.TITLE implicit",
    ]);
  });

  it("joins a JOINED subclass to its superclass on the primary key join columns, and targets SINGLE_TABLE subclasses at the root table", () => {
    expect(
      (poly.java.relations ?? []).map(
        (r) =>
          `${short(r.type)}${r.field ? `.${r.field}` : ""} @${r.kind} ${r.table}(${r.columns.join(",")})${r.implicit ? " implicit" : ""} -> ${r.target}${r.referenced ? `(${r.referenced.join(",")})` : ""}`,
      ),
    ).toEqual([
      "InspectionOrder @Inheritance INSPECTION_ORDER(INSP_ID) -> WORK_ORDER(ORDER_ID)",
      "RepairOrder @Inheritance REPAIR_ORDER(ORDER_ID) implicit -> WORK_ORDER",
      "Sensor.pump @ManyToOne SENSOR(PUMP_EQ_ID) implicit -> EQUIPMENT",
    ]);
  });

  it("judges the inheritance joins against the DDL keys and draws JOIN edges", () => {
    expect(
      compareJoinKeys(poly.java, poly.sql).map((f) =>
        f.kind === "join without foreign key"
          ? `${f.kind}: ${f.relation.table}(${f.relation.columns.join(",")})`
          : `${f.kind}: ${f.key.table}(${f.key.columns.join(",")})`,
      ),
    ).toEqual(["join without foreign key: INSPECTION_ORDER(INSP_ID)"]);
    expect(
      graph.edges.filter((e) => e.kind === "JOIN").map((e) => `${e.from} -> ${e.to} | ${e.via}`),
    ).toEqual([
      "table:INSPECTION_ORDER -> table:WORK_ORDER | @Inheritance InspectionOrder",
      "table:REPAIR_ORDER -> table:WORK_ORDER | @Inheritance RepairOrder",
      "table:SENSOR -> table:EQUIPMENT | @ManyToOne Sensor.pump",
    ]);
    expect(
      graph.edges
        .filter((e) => e.kind === "MAPS" && e.detail?.startsWith("discriminator"))
        .map((e) => `${e.from} -> ${e.to}`),
    ).toEqual(["type:jp.kazanami.plant.domain.Equipment -> column:EQUIPMENT.EQ_TYPE"]);
  });

  it("defaults a SINGLE_TABLE hierarchy's discriminator to DTYPE", () => {
    const tree = namedTree("jpa-inheritance-dtype", {
      ...java("Asset", "@Entity\npublic class Asset {\n  @Id\n  private Long id;\n}\n"),
      ...java("Motor", "@Entity\npublic class Motor extends Asset {\n  private Integer kw;\n}\n"),
    });
    const p = analyseProject(buildIndex(tree));
    expect(
      p.java.columns.map(
        (c) => `${c.discriminator ? "(discriminator)" : c.field} ${c.table}.${c.column}`,
      ),
    ).toEqual(["(discriminator) ASSET.DTYPE", "id ASSET.ID", "kw ASSET.KW"]);
  });

  it("lists the JOINED subclass joins in the design document's relationships", () => {
    const md = designDoc(index, { lang: "en", poly }).markdown;
    const at = md.indexOf("JPA relationships and foreign keys");
    const en = md.slice(at, md.indexOf("\n#", at + 1));
    const row = (mapping: string) => en.split("\n").find((l) => l.startsWith(`| \`${mapping}`));
    expect(row("RepairOrder @Inheritance")).toBeDefined();
    expect(row("InspectionOrder @Inheritance")).toContain("**none in the DDL (finding)**");
  });
});
