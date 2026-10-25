import { describe, expect, it } from "vitest";
import { designDoc } from "../design-doc.js";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { compareJoinKeys } from "./jpa-keys.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE SITE (SITE_ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE VALVE (ID BIGINT PRIMARY KEY, CREATED_AT TIMESTAMP, SITE_ID BIGINT REFERENCES SITE(SITE_ID), TAG VARCHAR(20));
CREATE TABLE TANK (ID BIGINT PRIMARY KEY, INSTALLED_AT TIMESTAMP, SITE_ID BIGINT, LITRES INTEGER);
CREATE TABLE GAUGE (ID BIGINT PRIMARY KEY, VALVE_ID BIGINT REFERENCES VALVE(ID));
CREATE TABLE ASSET (ASSET_ID BIGINT PRIMARY KEY);
CREATE TABLE COMPRESSOR (ASSET_ID BIGINT PRIMARY KEY REFERENCES ASSET(ASSET_ID), RPM INTEGER);
`;

const domain = "src/main/java/jp/kazanami/plant/domain";
const java = (name: string, body: string) => ({
  [`${domain}/${name}.java`]: `package jp.kazanami.plant.domain;\n\n${body}`,
});

const root = namedTree("jpa-mapped-superclass", {
  "db/plant.sql": DDL,
  ...java(
    "BaseEntity",
    `@MappedSuperclass
public abstract class BaseEntity {
  @Id
  private Long id;
}
`,
  ),
  ...java(
    "AuditedEntity",
    `@MappedSuperclass
public abstract class AuditedEntity extends BaseEntity {
  private java.time.Instant createdAt;
  @ManyToOne
  @JoinColumn(name = "SITE_ID")
  private Site site;
}
`,
  ),
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
    "Valve",
    `@Entity
@Table(name = "VALVE")
public class Valve extends AuditedEntity {
  private String tag;
}
`,
  ),
  ...java(
    "Tank",
    `@Entity
@Table(name = "TANK")
@AttributeOverride(name = "createdAt", column = @Column(name = "INSTALLED_AT"))
public class Tank extends AuditedEntity {
  private Integer litres;
}
`,
  ),
  ...java(
    "Gauge",
    `@Entity
public class Gauge {
  @Id
  private Long id;
  @ManyToOne
  private Valve valve;
}
`,
  ),
  ...java(
    "Asset",
    `@Entity
@Inheritance(strategy = InheritanceType.JOINED)
public class Asset {
  @Id
  @Column(name = "ASSET_ID")
  private Long id;
}
`,
  ),
  ...java(
    "Rotating",
    `@MappedSuperclass
public abstract class Rotating extends Asset {
  private Integer rpm;
}
`,
  ),
  ...java(
    "Compressor",
    `@Entity
@Table(name = "COMPRESSOR")
public class Compressor extends Rotating {
}
`,
  ),
});
const index = buildIndex(root);
const poly = analyseProject(index);
const graph = buildPolyglotGraph(poly);
const short = (qn: string) => qn.split(".").pop();

describe("JPA @MappedSuperclass", () => {
  it("maps no table for a mapped superclass", () => {
    expect(
      poly.java.tableUses
        .filter((u) => u.kind === "entity")
        .map((u) => `${short(u.type)} ${u.table}`)
        .toSorted(),
    ).toEqual([
      "Asset ASSET",
      "Compressor COMPRESSOR",
      "Gauge GAUGE",
      "Site SITE",
      "Tank TANK",
      "Valve VALVE",
    ]);
  });

  it("maps the mapped superclasses' fields on each entity's own table, with @AttributeOverride renames", () => {
    const cols = (type: string) =>
      poly.java.columns
        .filter((c) => short(c.type) === type)
        .map((c) => `${c.field} ${c.table}.${c.column}${c.implicit ? " implicit" : ""}`)
        .toSorted();
    expect(cols("Valve")).toEqual([
      "createdAt VALVE.CREATED_AT implicit",
      "id VALVE.ID implicit",
      "site VALVE.SITE_ID",
      "tag VALVE.TAG implicit",
    ]);
    expect(cols("Tank")).toEqual([
      "createdAt TANK.INSTALLED_AT",
      "id TANK.ID implicit",
      "litres TANK.LITRES implicit",
      "site TANK.SITE_ID",
    ]);
    expect(cols("Compressor")).toEqual([
      " COMPRESSOR.ASSET_ID implicit",
      "rpm COMPRESSOR.RPM implicit",
    ]);
  });

  it("owns the mapped superclass's relations per entity, inherits its @Id, and sees entity superclasses through it", () => {
    expect(
      (poly.java.relations ?? [])
        .map(
          (r) =>
            `${short(r.type)}${r.field ? `.${r.field}` : ""} @${r.kind} ${r.table}(${r.columns.join(",")})${r.implicit ? " implicit" : ""} -> ${r.target}`,
        )
        .toSorted(),
    ).toEqual([
      "Compressor @Inheritance COMPRESSOR(ASSET_ID) implicit -> ASSET",
      "Gauge.valve @ManyToOne GAUGE(VALVE_ID) implicit -> VALVE",
      "Tank.site @ManyToOne TANK(SITE_ID) -> SITE",
      "Valve.site @ManyToOne VALVE(SITE_ID) -> SITE",
    ]);
  });

  it("judges the inherited joins per table against the DDL keys", () => {
    expect(
      compareJoinKeys(poly.java, poly.sql).map((f) =>
        f.kind === "join without foreign key"
          ? `${f.kind}: ${f.relation.table}(${f.relation.columns.join(",")})`
          : `${f.kind}: ${f.key.table}(${f.key.columns.join(",")})`,
      ),
    ).toEqual(["join without foreign key: TANK(SITE_ID)"]);
    expect(
      graph.edges
        .filter((e) => e.kind === "JOIN")
        .map((e) => `${e.from} -> ${e.to}`)
        .toSorted(),
    ).toEqual([
      "table:COMPRESSOR -> table:ASSET",
      "table:GAUGE -> table:VALVE",
      "table:TANK -> table:SITE",
      "table:VALVE -> table:SITE",
    ]);
  });

  it("lists the inherited relations in the design document", () => {
    const md = designDoc(index, { lang: "en", poly }).markdown;
    const at = md.indexOf("JPA relationships and foreign keys");
    const en = md.slice(at, md.indexOf("\n#", at + 1));
    const row = (mapping: string) => en.split("\n").find((l) => l.startsWith(`| \`${mapping}`));
    expect(row("Valve.site")).toBeDefined();
    expect(row("Tank.site")).toContain("**none in the DDL (finding)**");
  });
});
