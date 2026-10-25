import { describe, expect, it } from "vitest";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE PRESS (ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE PRESS_LICENCE (PRESS_ID BIGINT PRIMARY KEY REFERENCES PRESS(ID), ISSUER VARCHAR(40));
CREATE TABLE DIE_SLOT (PRESS_ID BIGINT REFERENCES PRESS(ID), SLOT INTEGER, DIE VARCHAR(20),
  PRIMARY KEY (PRESS_ID, SLOT));
CREATE TABLE LICENCE_AUDIT (ID BIGINT PRIMARY KEY,
  LICENCE_PRESS_ID BIGINT REFERENCES PRESS_LICENCE(PRESS_ID));
`;

const domain = "src/main/java/jp/kazanami/plant/domain";
const java = (name: string, body: string) => ({
  [`${domain}/${name}.java`]: `package jp.kazanami.plant.domain;\n\n${body}`,
});

const root = namedTree("jpa-id-to-one", {
  "db/plant.sql": DDL,
  ...java(
    "Press",
    `@Entity
public class Press {
  @Id
  private Long id;
  private String name;
}
`,
  ),
  ...java(
    "PressLicence",
    `@Entity
@Table(name = "PRESS_LICENCE")
public class PressLicence {
  @Id
  @OneToOne
  @JoinColumn(name = "PRESS_ID")
  private Press press;
  private String issuer;
}
`,
  ),
  ...java(
    "DieSlotId",
    `public class DieSlotId implements java.io.Serializable {
  private Long press;
  private Integer slot;
}
`,
  ),
  ...java(
    "DieSlot",
    `@Entity
@Table(name = "DIE_SLOT")
@IdClass(DieSlotId.class)
public class DieSlot {
  @Id
  @ManyToOne
  private Press press;
  @Id
  private Integer slot;
  private String die;
}
`,
  ),
  ...java(
    "LicenceAudit",
    `@Entity
@Table(name = "LICENCE_AUDIT")
public class LicenceAudit {
  @Id
  private Long id;
  @ManyToOne
  private PressLicence licence;
}
`,
  ),
});
const index = buildIndex(root);
const poly = analyseProject(index);

describe("JPA derived identity: @Id on a to-one", () => {
  it("maps the key on the relationship's join column, with or without @IdClass", () => {
    expect(
      poly.java.columns
        .filter((c) => c.table !== "PRESS")
        .map((c) => `${c.table}.${c.column} ${c.field}${c.implicit ? " implicit" : ""}`)
        .toSorted(),
    ).toEqual([
      "DIE_SLOT.DIE die implicit",
      "DIE_SLOT.PRESS_ID press implicit",
      "DIE_SLOT.SLOT slot implicit",
      "LICENCE_AUDIT.ID id implicit",
      "LICENCE_AUDIT.LICENCE_PRESS_ID licence implicit",
      "PRESS_LICENCE.ISSUER issuer implicit",
      "PRESS_LICENCE.PRESS_ID press",
    ]);
  });

  it("defaults a join column to an @Id to-one target's key and flags nothing missing", () => {
    const graph = buildPolyglotGraph(poly);
    const missing = graph.nodes
      .filter((n) => n.kind === "column" && n.attrs?.defined === "not in the analysed DDL")
      .map((n) => `${n.attrs?.table}.${n.name}`);
    expect(missing).toEqual([]);
  });
});
