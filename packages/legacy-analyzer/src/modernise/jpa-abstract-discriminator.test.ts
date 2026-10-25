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

// Fictional plant: an abstract SINGLE_TABLE root and an abstract middle entity named like a
// concrete one's written value. Neither has rows, so neither has a default value or a duplicate.
const root = namedTree("jpa-abstract-discriminator", {
  "db/plant.sql": `CREATE TABLE ASSET (ID BIGINT PRIMARY KEY, DTYPE VARCHAR(31));\n`,
  ...java("Asset", "@Entity\npublic abstract class Asset {\n  @Id\n  private Long id;\n}\n"),
  ...java("Rotating", "@Entity\npublic abstract class Rotating extends Asset {\n}\n"),
  ...java(
    "Pump",
    '@Entity\n@DiscriminatorValue("Rotating")\npublic class Pump extends Rotating {\n}\n',
  ),
  ...java("Tank", "@Entity\npublic class Tank extends Asset {\n}\n"),
});
const index = buildIndex(root);
const poly = analyseProject(index);
const short = (qn: string) => qn.split(".").pop();

describe("JPA discriminator of an abstract entity", () => {
  it("gives an abstract entity no default value and never counts it as a duplicate", () => {
    expect(
      poly.java.tableUses
        .filter((u) => u.kind === "entity")
        .map((u) => {
          const d = u.discriminator;
          return `${short(u.type)} ${d?.column}=${d?.value ?? "-"}${d?.abstract ? " abstract" : ""}${d?.duplicate ? " duplicate" : ""}`;
        })
        .toSorted(),
    ).toEqual([
      "Asset DTYPE=- abstract",
      "Pump DTYPE=Rotating",
      "Rotating DTYPE=- abstract",
      "Tank DTYPE=Tank",
    ]);
  });

  it("says so on the graph's MAPS edge", () => {
    const graph = buildPolyglotGraph(poly);
    expect(
      graph.edges
        .filter((e) => e.kind === "MAPS" && e.from.endsWith(".Asset") && e.to === "table:ASSET")
        .map((e) => e.detail),
    ).toEqual(["@Entity (default name); DTYPE = (abstract, no rows)"]);
  });

  it("says so in the design document, JA and EN", () => {
    const en = designDoc(index, { lang: "en", poly }).markdown;
    const ja = designDoc(index, { lang: "ja", poly }).markdown;
    expect(en).toContain("discriminator DTYPE = none (abstract entity, no rows)");
    expect(ja).toContain("識別子 DTYPE = なし（抽象エンティティ、行なし）");
    expect(en).not.toContain("discriminator DTYPE = 'Asset'");
    expect(en).not.toContain("(finding)");
  });
});
