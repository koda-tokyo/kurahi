import { describe, expect, it } from "vitest";
import { buildIndex } from "../indexer.js";
import { namedTree } from "../test-fixtures/doc-check.js";
import { A, B, program } from "../test-fixtures/helpers.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { crossImpact } from "./poly-impact.js";
import { analyseProject } from "./project.js";

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

const PAYCLOSE = program("PAYCLOSE", {
  data: [A("WORKING-STORAGE SECTION."), A("01 WS-PERIOD PIC X(6)."), A("01 WS-PROC PIC X(18).")],
  proc: [
    A("1000-CLOSE."),
    B("EXEC SQL CALL PAYROLL.P_CLOSE(:WS-PERIOD) END-EXEC."),
    A("2000-ARCHIVE."),
    B("EXEC SQL"),
    B("  CALL PAY_PKG.ARCHIVE (:WS-PERIOD)"),
    B("END-EXEC."),
    A("3000-DYNAMIC."),
    B("EXEC SQL CALL :WS-PROC (:WS-PERIOD) END-EXEC."),
    B("EXEC SQL CALL P_MISSING END-EXEC."),
    B("STOP RUN."),
  ],
});

const PLI = ` PAYPLI: PROC OPTIONS(MAIN);
   DCL WS_PERIOD CHAR(6);
   CALL CLOSE_ONE;
 CLOSE_ONE: PROC;
   EXEC SQL CALL P_CLOSE(:WS_PERIOD);
 END CLOSE_ONE;
 END PAYPLI;`;

const root = namedTree("cobol-routine-calls", {
  "db/payroll.sql": DDL,
  "cobol/PAYCLOSE.cbl": PAYCLOSE,
  "pli/PAYPLI.pli": PLI,
});
const poly = analyseProject(buildIndex(root));
const graph = buildPolyglotGraph(poly);

describe("COBOL and PL/I EXEC SQL CALL into stored routines", () => {
  it("links each static CALL to its routine, the paragraph or procedure as the paragraph", () => {
    const calls = graph.edges
      .filter((e) => e.kind === "CALL" && e.detail === "EXEC SQL CALL")
      .map((e) => `${e.from} -> ${e.to} | ${e.paragraph ?? "-"} | ${e.loc.file}:${e.loc.line}`);
    expect(calls).toEqual([
      "program:PAYCLOSE -> routine:PAY_PKG.ARCHIVE | 2000-ARCHIVE | cobol/PAYCLOSE.cbl:12",
      "program:PAYCLOSE -> routine:P_CLOSE | 1000-CLOSE | cobol/PAYCLOSE.cbl:10",
      "program:PAYCLOSE -> routine:P_MISSING | 3000-DYNAMIC | cobol/PAYCLOSE.cbl:17",
      "program:PAYPLI -> routine:P_CLOSE | CLOSE_ONE | pli/PAYPLI.pli:5",
    ]);
  });

  it("keeps undefined routines as nodes that say so and ignores CALL :host-variable", () => {
    expect(graph.nodes.find((n) => n.id === "routine:P_MISSING")?.attrs).toEqual({
      defined: "not in the analysed DDL",
    });
    expect(graph.nodes.find((n) => n.id === "routine:P_CLOSE")?.attrs?.defined).toBeUndefined();
    expect(graph.nodes.some((n) => n.id.startsWith("routine:WS-PROC"))).toBe(false);
  });

  it("reaches the COBOL and PL/I callers from a table change through the routine", () => {
    const r = crossImpact(poly, graph, "PAY_RESULT");
    expect(r.found).toBe(true);
    expect(r.callers.map((c) => c.name)).toEqual(expect.arrayContaining(["PAYCLOSE", "PAYPLI"]));
  });
});
