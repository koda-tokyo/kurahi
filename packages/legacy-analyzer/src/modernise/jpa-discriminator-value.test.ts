import { describe, expect, it } from "vitest";
import { designDoc } from "../design-doc.js";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { analyseProject } from "./project.js";

const domain = "src/main/java/jp/kazanami/plant/domain";
const java = (name: string, body: string) => ({
  [`${domain}/${name}.java`]: `package jp.kazanami.plant.domain;\n\n${body}`,
});

const root = namedTree("jpa-discriminator-value", {
  "db/plant.sql": `CREATE TABLE EQUIPMENT (EQ_ID BIGINT PRIMARY KEY, EQ_TYPE VARCHAR(8));
CREATE TABLE ALARM (ID BIGINT PRIMARY KEY, KIND INTEGER);
`,
  ...java(
    "Equipment",
    `@Entity
@Table(name = "EQUIPMENT")
@DiscriminatorColumn(name = "EQ_TYPE")
@DiscriminatorValue("EQ")
public class Equipment {
  @Id
  @Column(name = "EQ_ID")
  private Long id;
}
`,
  ),
  ...java(
    "Pump",
    `@Entity\n@DiscriminatorValue("PUMP")\npublic class Pump extends Equipment {\n}\n`,
  ),
  ...java("Valve", `@Entity(name = "Valve")\npublic class Valve extends Equipment {\n}\n`),
  ...java(
    "Compressor",
    `@Entity\n@DiscriminatorValue("PUMP")\npublic class Compressor extends Equipment {\n}\n`,
  ),
  ...java(
    "Alarm",
    `@Entity
@Inheritance(strategy = InheritanceType.JOINED)
@DiscriminatorColumn(name = "KIND", discriminatorType = DiscriminatorType.INTEGER)
public class Alarm {
  @Id
  private Long id;
}
`,
  ),
  ...java(
    "TripAlarm",
    `@Entity\n@DiscriminatorValue("2")\npublic class TripAlarm extends Alarm {\n}\n`,
  ),
  ...java("LowAlarm", `@Entity\npublic class LowAlarm extends Alarm {\n}\n`),
  ...java(
    "Reading",
    `@Entity
@Inheritance(strategy = InheritanceType.TABLE_PER_CLASS)
public class Reading {
  @Id
  private Long id;
}
`,
  ),
  ...java(
    "TempReading",
    `@Entity\n@DiscriminatorValue("T")\npublic class TempReading extends Reading {\n}\n`,
  ),
  ...java("Site", `@Entity\npublic class Site {\n  @Id\n  private Long id;\n}\n`),
});
const index = buildIndex(root);
const poly = analyseProject(index);
const short = (qn: string) => qn.split(".").pop();
const describeUse = (u: (typeof poly.java.tableUses)[number]) => {
  const d = u.discriminator;
  return `${short(u.type)} ${u.table}${
    d
      ? ` ${short(d.root)} ${d.column}=${d.value ?? "?"}${d.implicit ? " implicit" : ""}${d.duplicate ? " duplicate" : ""}`
      : ""
  }`;
};

describe("JPA @DiscriminatorValue", () => {
  it("gives each entity of a discriminated hierarchy its value: written, the entity name for STRING, provider-specific otherwise", () => {
    expect(
      poly.java.tableUses
        .filter((u) => u.kind === "entity")
        .map(describeUse)
        .toSorted(),
    ).toEqual([
      "Alarm ALARM Alarm KIND=? implicit",
      "Compressor EQUIPMENT Equipment EQ_TYPE=PUMP duplicate",
      "Equipment EQUIPMENT Equipment EQ_TYPE=EQ",
      "LowAlarm LOW_ALARM Alarm KIND=? implicit",
      "Pump EQUIPMENT Equipment EQ_TYPE=PUMP duplicate",
      "Reading READING",
      "Site SITE",
      "TempReading TEMP_READING",
      "TripAlarm TRIP_ALARM Alarm KIND=2",
      "Valve EQUIPMENT Equipment EQ_TYPE=Valve implicit",
    ]);
  });

  it("defaults a DTYPE hierarchy's values to the entity names", () => {
    const tree = namedTree("jpa-discriminator-dtype", {
      ...java("Asset", "@Entity\npublic class Asset {\n  @Id\n  private Long id;\n}\n"),
      ...java("Motor", '@Entity(name = "ElectricMotor")\npublic class Motor extends Asset {\n}\n'),
    });
    expect(
      analyseProject(buildIndex(tree))
        .java.tableUses.filter((u) => u.kind === "entity")
        .map(describeUse),
    ).toEqual([
      "Asset ASSET Asset DTYPE=Asset implicit",
      "Motor ASSET Asset DTYPE=ElectricMotor implicit",
    ]);
  });

  it("puts the value on the graph's MAPS edge", () => {
    const graph = buildPolyglotGraph(poly);
    expect(
      graph.edges
        .filter((e) => e.kind === "MAPS" && e.from.endsWith(".Pump") && e.to === "table:EQUIPMENT")
        .map((e) => e.detail),
    ).toEqual(["@Inheritance(SINGLE_TABLE) Equipment; EQ_TYPE = 'PUMP' (duplicate)"]);
  });

  it("states the value in the design document and flags a duplicate as a finding, JA and EN", () => {
    const en = designDoc(index, { lang: "en", poly }).markdown;
    const ja = designDoc(index, { lang: "ja", poly }).markdown;
    const line = (md: string, needle: string) => md.split("\n").find((l) => l.includes(needle));
    expect(line(en, "discriminator EQ_TYPE = 'Valve'")).toContain("(default: entity name)");
    expect(line(en, "discriminator EQ_TYPE = 'PUMP'")).toContain(
      "**same value as another entity of the hierarchy (finding)**",
    );
    expect(line(en, "discriminator KIND = provider-specific value")).toBeDefined();
    expect(line(ja, "識別子 EQ_TYPE = 'PUMP'")).toContain("（指摘）");
    expect(en).not.toContain("discriminator EQ_TYPE = 'T'");
  });
});
