import { describe, expect, it } from "vitest";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { compareJoinKeys } from "./jpa-keys.js";
import { analyseProject } from "./project.js";

const DDL = `CREATE TABLE OPERATOR (OPERATOR_ID BIGINT PRIMARY KEY, NAME VARCHAR(40));
CREATE TABLE BATCH (ID BIGINT PRIMARY KEY, RELEASED_BY BIGINT REFERENCES OPERATOR(OPERATOR_ID));
CREATE TABLE SHIFT (ID BIGINT PRIMARY KEY, OUTGOING_ID BIGINT REFERENCES OPERATOR(OPERATOR_ID),
  OUTGOING_NOTE VARCHAR(200), RELIEF_ID BIGINT, NOTE VARCHAR(200));
`;

const domain = "src/main/java/jp/kazanami/plant/domain";
const java = (name: string, body: string) => ({
  [`${domain}/${name}.java`]: `package jp.kazanami.plant.domain;\n\n${body}`,
});

const root = namedTree("jpa-association-override", {
  "db/plant.sql": DDL,
  ...java(
    "Operator",
    `@Entity
public class Operator {
  @Id
  @Column(name = "OPERATOR_ID")
  private Long id;
  private String name;
}
`,
  ),
  ...java(
    "Released",
    `@MappedSuperclass
public abstract class Released {
  @Id
  private Long id;
  @ManyToOne
  @JoinColumn(name = "OPERATOR_ID")
  private Operator operator;
}
`,
  ),
  ...java(
    "Batch",
    `@Entity
@AssociationOverride(name = "operator", joinColumns = @JoinColumn(name = "RELEASED_BY"))
public class Batch extends Released {
}
`,
  ),
  ...java(
    "Handover",
    `@Embeddable
public class Handover {
  @ManyToOne
  private Operator operator;
  private String note;
}
`,
  ),
  ...java(
    "Shift",
    `@Entity
@AssociationOverride(name = "incoming.operator", joinColumns = @JoinColumn(name = "RELIEF_ID"))
public class Shift {
  @Id
  private Long id;
  @Embedded
  @AttributeOverride(name = "note", column = @Column(name = "OUTGOING_NOTE"))
  @AssociationOverrides({
    @AssociationOverride(name = "operator",
      joinColumns = { @JoinColumn(name = "OUTGOING_ID", referencedColumnName = "OPERATOR_ID") })
  })
  private Handover outgoing;
  @Embedded
  @AssociationOverride(name = "operator", joinColumns = @JoinColumn(name = "INCOMING_ID"))
  private Handover incoming;
}
`,
  ),
});
const index = buildIndex(root);
const poly = analyseProject(index);
const short = (qn: string) => qn.split(".").pop();
const rels = () =>
  (poly.java.relations ?? [])
    .map(
      (r) =>
        `${short(r.type)}.${r.field} ${r.table}(${r.columns.join(",")})${r.referenced ? `=${r.referenced.join(",")}` : ""}${r.implicit ? " implicit" : ""} -> ${r.target}`,
    )
    .toSorted();

describe("JPA @AssociationOverride", () => {
  it("replaces a mapped superclass's join column on the entity's table", () => {
    expect(rels()).toContain("Batch.operator BATCH(RELEASED_BY) -> OPERATOR");
    expect(
      poly.java.columns
        .filter((c) => short(c.type) === "Batch")
        .map((c) => `${c.field} ${c.table}.${c.column}${c.implicit ? " implicit" : ""}`)
        .toSorted(),
    ).toEqual(["id BATCH.ID implicit", "operator BATCH.RELEASED_BY"]);
  });

  it("renames an embeddable's to-one join per embedded field, the outermost override winning", () => {
    expect(rels().filter((r) => r.startsWith("Shift."))).toEqual([
      "Shift.incoming.operator SHIFT(RELIEF_ID) -> OPERATOR",
      "Shift.outgoing.operator SHIFT(OUTGOING_ID)=OPERATOR_ID -> OPERATOR",
    ]);
    expect(
      poly.java.columns
        .filter((c) => short(c.type) === "Shift")
        .map((c) => `${c.field} ${c.table}.${c.column}${c.implicit ? " implicit" : ""}`)
        .toSorted(),
    ).toEqual([
      "id SHIFT.ID implicit",
      "incoming.note SHIFT.NOTE implicit",
      "incoming.operator SHIFT.RELIEF_ID",
      "outgoing.note SHIFT.OUTGOING_NOTE",
      "outgoing.operator SHIFT.OUTGOING_ID",
    ]);
  });

  it("judges the overridden join columns against the DDL keys", () => {
    expect(
      compareJoinKeys(poly.java, poly.sql).map((f) =>
        f.kind === "join without foreign key"
          ? `${f.kind}: ${f.relation.table}(${f.relation.columns.join(",")})`
          : `${f.kind}: ${f.key.table}(${f.key.columns.join(",")})`,
      ),
    ).toEqual(["join without foreign key: SHIFT(RELIEF_ID)"]);
  });
});
