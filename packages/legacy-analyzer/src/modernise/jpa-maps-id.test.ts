import { describe, expect, it } from "vitest";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE PRESS (ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE PRESS_PROFILE (PRESS_ID BIGINT PRIMARY KEY REFERENCES PRESS(ID), LABEL VARCHAR(40));
CREATE TABLE TOOL_WEAR (PRESS_ID BIGINT REFERENCES PRESS(ID), SLOT INTEGER, WEAR INTEGER,
  PRIMARY KEY (PRESS_ID, SLOT));
CREATE TABLE PROFILE_NOTE (ID BIGINT PRIMARY KEY,
  PROFILE_PRESS_ID BIGINT REFERENCES PRESS_PROFILE(PRESS_ID));
`;

const domain = "src/main/java/jp/kazanami/plant/domain";
const java = (name: string, body: string) => ({
  [`${domain}/${name}.java`]: `package jp.kazanami.plant.domain;\n\n${body}`,
});

const root = namedTree("jpa-maps-id", {
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
    "PressProfile",
    `@Entity
@Table(name = "PRESS_PROFILE")
public class PressProfile {
  @Id
  private Long id;
  @MapsId
  @OneToOne
  @JoinColumn(name = "PRESS_ID")
  private Press press;
  private String label;
}
`,
  ),
  ...java(
    "ToolWearId",
    `@Embeddable
public class ToolWearId {
  private Long pressId;
  private Integer slot;
}
`,
  ),
  ...java(
    "ToolWear",
    `@Entity
@Table(name = "TOOL_WEAR")
public class ToolWear {
  @EmbeddedId
  private ToolWearId key;
  @MapsId("pressId")
  @ManyToOne
  private Press press;
  private Integer wear;
}
`,
  ),
  ...java(
    "ProfileNote",
    `@Entity
@Table(name = "PROFILE_NOTE")
public class ProfileNote {
  @Id
  private Long id;
  @ManyToOne
  private PressProfile profile;
}
`,
  ),
});
const index = buildIndex(root);
const poly = analyseProject(index);

describe("JPA @MapsId derived identity", () => {
  it("maps the id attribute on the relationship's join column instead of a column of its own", () => {
    expect(
      poly.java.columns
        .filter((c) => c.table !== "PRESS")
        .map(
          (c) =>
            `${c.table}.${c.column} ${c.field}${c.mapsId ? ` maps ${c.mapsId}` : ""}${c.implicit ? " implicit" : ""}`,
        )
        .toSorted(),
    ).toEqual([
      "PRESS_PROFILE.LABEL label implicit",
      "PRESS_PROFILE.PRESS_ID press maps id",
      "PROFILE_NOTE.ID id implicit",
      "PROFILE_NOTE.PROFILE_PRESS_ID profile implicit",
      "TOOL_WEAR.PRESS_ID press maps key.pressId implicit",
      "TOOL_WEAR.SLOT key.slot implicit",
      "TOOL_WEAR.WEAR wear implicit",
    ]);
  });

  it("defaults a join column to a derived-identity target's key and flags nothing missing", () => {
    const graph = buildPolyglotGraph(poly);
    const missing = graph.nodes
      .filter((n) => n.kind === "column" && n.attrs?.defined === "not in the analysed DDL")
      .map((n) => `${n.attrs?.table}.${n.name}`);
    expect(missing).toEqual([]);
    const maps = graph.edges
      .filter((e) => e.kind === "MAPS" && e.detail?.includes("maps id"))
      .map((e) => e.detail)
      .toSorted((a, b) => ((a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0));
    expect(maps).toEqual(["press (implicit name); maps id key.pressId", "press; maps id id"]);
  });
});
