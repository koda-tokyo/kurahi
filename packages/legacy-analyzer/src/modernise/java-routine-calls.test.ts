import { describe, expect, it } from "vitest";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { crossImpact } from "./poly-impact.js";
import { analyseProject } from "./project.js";
import { looksLikeSql, routineCall } from "./sql-text.js";

const DDL = `CREATE TABLE PAYROLL.PAY_RESULT (EMP_ID CHAR(6) NOT NULL, NET_PAY DECIMAL(9, 0));

CREATE PROCEDURE PAYROLL.P_CLOSE (IN P_PERIOD CHAR(6))
LANGUAGE SQL
BEGIN
  UPDATE PAY_RESULT SET NET_PAY = 0 WHERE EMP_ID = P_PERIOD;
END;

CREATE OR REPLACE PACKAGE BODY PAY_PKG AS
  PROCEDURE ARCHIVE (p_period IN CHAR) IS
  BEGIN
    DELETE FROM PAY_RESULT WHERE EMP_ID = p_period;
  END ARCHIVE;
END PAY_PKG;
/
`;

const SERVICE = `package jp.kazanami.payroll.service;

import java.sql.Connection;

public class CloseService {
  private static final String CLOSE = "{call PAYROLL.P_CLOSE(?)}";
  private static final String UNUSED = "CALL P_UNUSED(?)";

  public void close(Connection c, String period) throws Exception {
    c.prepareCall(CLOSE).execute();
  }

  public void archive(Connection c) throws Exception {
    c.prepareCall("{? = call pay_pkg.archive(?)}").execute();
  }

  public void purge(javax.persistence.EntityManager em) {
    em.createStoredProcedureQuery("P_PURGE").execute();
  }

  public void report(CloseRepository repo) {
    repo.closePeriod("202410");
  }
}
`;

const REPO = `package jp.kazanami.payroll.service;

import org.springframework.data.jpa.repository.query.Procedure;

public interface CloseRepository {
  @Procedure(procedureName = "P_CLOSE")
  void closePeriod(String period);

  @Procedure(name = "PayResult.archive")
  void archiveNamed(String period);

  @Procedure
  void recalc(String period);

  @Procedure(name = "Missing.query")
  void missing(String period);
}
`;

const ENTITY = `package jp.kazanami.payroll.domain;

@Entity
@NamedStoredProcedureQuery(name = "PayResult.archive", procedureName = "PAY_PKG.ARCHIVE")
@Table(name = "PAY_RESULT")
public class PayResult {
  private String empId;
}
`;

const MAPPER_JAVA = `package jp.kazanami.payroll.mapper;

public interface CloseMapper {
  void close(String period);
}
`;

const MAPPER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="jp.kazanami.payroll.mapper.CloseMapper">
  <select id="close" statementType="CALLABLE">{call P_CLOSE(#{period, mode=IN})}</select>
</mapper>`;

const root = namedTree("routine-calls", {
  "db/payroll.sql": DDL,
  "src/main/java/jp/kazanami/payroll/service/CloseService.java": SERVICE,
  "src/main/java/jp/kazanami/payroll/service/CloseRepository.java": REPO,
  "src/main/java/jp/kazanami/payroll/domain/PayResult.java": ENTITY,
  "src/main/java/jp/kazanami/payroll/mapper/CloseMapper.java": MAPPER_JAVA,
  "src/main/resources/mapper/CloseMapper.xml": MAPPER_XML,
});
const poly = analyseProject(buildIndex(root));
const graph = buildPolyglotGraph(poly);

describe("host-language calls into stored routines", () => {
  it("reads CALL text and the JDBC call escapes as routine names", () => {
    expect(routineCall("CALL payroll.p_close(?)")).toEqual(["PAYROLL", "P_CLOSE"]);
    expect(routineCall("{call P_CLOSE(?)}")).toEqual(["P_CLOSE"]);
    expect(routineCall(" { ? = call pay_pkg.archive(?) } ")).toEqual(["PAY_PKG", "ARCHIVE"]);
    expect(routineCall("SELECT * FROM T")).toBeUndefined();
    expect(routineCall("{call}")).toBeUndefined();
    expect(looksLikeSql("{? = call f(?)}")).toBe(true);
    expect(looksLikeSql("{callback}")).toBe(false);
  });

  it("finds JDBC, constant, stored-procedure API, @Procedure, named query and MyBatis calls", () => {
    expect(
      (poly.java.routineCalls ?? []).map(
        (c) =>
          `${c.type.split(".").pop()}${c.method ? `#${c.method}` : ""} -> ${c.routine.join(".")} | ${c.via} | ${c.file.split("/").pop()}:${c.line}`,
      ),
    ).toEqual([
      "PayResult -> PAY_PKG.ARCHIVE | @NamedStoredProcedureQuery PayResult.archive | PayResult.java:4",
      "CloseRepository#closePeriod(String) -> P_CLOSE | @Procedure | CloseRepository.java:6",
      "CloseRepository#archiveNamed(String) -> PAY_PKG.ARCHIVE | @Procedure(name = PayResult.archive) | CloseRepository.java:9",
      "CloseRepository#recalc(String) -> RECALC | @Procedure (method name) | CloseRepository.java:12",
      "CloseRepository#missing(String) -> MISSING.QUERY | @Procedure(name = Missing.query): no @NamedStoredProcedureQuery of that name in the sources | CloseRepository.java:15",
      "CloseService -> P_UNUSED | CALL constant UNUSED (no method reference found) | CloseService.java:7",
      "CloseService#close(Connection, String) -> PAYROLL.P_CLOSE | JDBC CALL (constant CLOSE) | CloseService.java:10",
      "CloseService#archive(Connection) -> PAY_PKG.ARCHIVE | JDBC CALL | CloseService.java:14",
      "CloseService#purge(javax.persistence.EntityManager) -> P_PURGE | createStoredProcedureQuery | CloseService.java:18",
      'CloseMapper#close(String) -> P_CLOSE | MyBatis <select id="close"> CALL | CloseMapper.xml:3',
    ]);
  });

  it("links callers to routine nodes; a schema prefix the DDL defines binds the bare routine", () => {
    const calls = graph.edges
      .filter((e) => e.kind === "CALL" && e.from.startsWith("type:"))
      .map((e) => `${e.from.split(".").pop()} -> ${e.to}`);
    expect(calls).toEqual(
      expect.arrayContaining([
        "CloseService -> routine:P_CLOSE",
        "CloseService -> routine:PAY_PKG.ARCHIVE",
        "CloseRepository -> routine:P_CLOSE",
        "CloseMapper -> routine:P_CLOSE",
        "PayResult -> routine:PAY_PKG.ARCHIVE",
      ]),
    );
    // Calls into routines the DDL does not define stay as nodes that say so.
    const purge = graph.nodes.find((n) => n.id === "routine:P_PURGE");
    expect(purge?.attrs).toEqual({ defined: "not in the analysed DDL" });
    expect(graph.nodes.find((n) => n.id === "routine:P_CLOSE")?.attrs?.defined).toBeUndefined();
  });

  it("reaches the Java callers from a table change through the routine", () => {
    const r = crossImpact(poly, graph, "PAY_RESULT");
    expect(r.found).toBe(true);
    const callers = r.callers.map((c) => c.name);
    expect(callers).toEqual(
      expect.arrayContaining(["CloseService", "CloseRepository", "CloseMapper"]),
    );
  });

  it("reads @NamedStoredProcedureQueries containers and repeated @NamedStoredProcedureQuery", () => {
    const tree = namedTree("routine-containers", {
      "src/main/java/jp/kazanami/payroll/domain/PayRun.java": `package jp.kazanami.payroll.domain;

@Entity
@NamedStoredProcedureQueries({
  @NamedStoredProcedureQuery(
    name = "PayRun.close",
    procedureName = "PAYROLL.P_CLOSE",
    parameters = { @StoredProcedureParameter(mode = ParameterMode.IN, type = String.class) }),
  @NamedStoredProcedureQuery(name = "PayRun.archive", procedureName = "PAY_PKG.ARCHIVE")
})
public class PayRun {}
`,
      "src/main/java/jp/kazanami/payroll/domain/PayLine.java": `package jp.kazanami.payroll.domain;

@Entity
@NamedStoredProcedureQuery(name = "PayLine.recalc", procedureName = "P_RECALC")
@NamedStoredProcedureQuery(name = "PayLine.purge", procedureName = "P_PURGE")
public class PayLine {}
`,
      "src/main/java/jp/kazanami/payroll/domain/PayRunRepository.java": `package jp.kazanami.payroll.domain;

public interface PayRunRepository {
  @Procedure(name = "PayRun.archive")
  void archive(String period);

  @Procedure(name = "PayLine.purge")
  void purge(String period);
}
`,
    });
    const p = analyseProject(buildIndex(tree));
    expect(
      (p.java.routineCalls ?? []).map(
        (c) =>
          `${c.type.split(".").pop()}${c.method ? `#${c.method}` : ""} -> ${c.routine.join(".")} | ${c.via} | ${c.file.split("/").pop()}:${c.line}${c.declaredAt ? ` (declared ${c.declaredAt.line})` : ""}`,
      ),
    ).toEqual(
      expect.arrayContaining([
        "PayRun -> PAYROLL.P_CLOSE | @NamedStoredProcedureQuery PayRun.close | PayRun.java:5",
        "PayRun -> PAY_PKG.ARCHIVE | @NamedStoredProcedureQuery PayRun.archive | PayRun.java:9",
        "PayLine -> P_RECALC | @NamedStoredProcedureQuery PayLine.recalc | PayLine.java:4",
        "PayLine -> P_PURGE | @NamedStoredProcedureQuery PayLine.purge | PayLine.java:5",
        "PayRunRepository#archive(String) -> PAY_PKG.ARCHIVE | @Procedure(name = PayRun.archive) | PayRunRepository.java:4 (declared 9)",
        "PayRunRepository#purge(String) -> P_PURGE | @Procedure(name = PayLine.purge) | PayRunRepository.java:7 (declared 5)",
      ]),
    );
    // The parameter annotation nested in a query is not itself a named query.
    expect((p.java.routineCalls ?? []).filter((c) => c.type.endsWith("PayRun"))).toHaveLength(2);
  });
});
