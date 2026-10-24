import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyQuery } from "./api.js";
import { crudMatrix, viewOf } from "./crud.js";
import { callChains, datasetLineage, neighbours, programDependencies } from "./graph-query.js";
import { buildGraph, parseCics } from "./graph.js";
import { buildIndex } from "./indexer.js";
import { tmpTree } from "./test-fixtures/helpers.js";
import { MIXED_FILES } from "./test-fixtures/mixed.js";

const root = tmpTree({ ...MIXED_FILES, "output/.keep": "" });
const graph = buildGraph(buildIndex(root));
const view = viewOf(graph);
const edge = (from: string, kind: string, to: string) =>
  graph.edges.filter((e) => e.from === from && e.kind === kind && e.to === to);

describe("knowledge graph", () => {
  it("links CALLs: static, dynamic, without source and CICS LINK, each with file:line", () => {
    expect(edge("program:ORDMAIN", "CALL", "program:ORDLOG")).toMatchObject([
      { detail: "static", loc: { file: "cobol/ORDMAIN.cbl" }, paragraph: "2000-UPDATE" },
    ]);
    expect(edge("program:ORDMAIN", "CALL", "dynamic:ORDMAIN.WS-PGM")[0]?.detail).toBe(
      "CALL dynamic",
    );
    expect(view.node.get("program:EXTUTIL")?.kind).toBe("external-program");
    expect(edge("program:ORDLOG", "CALL", "program:ORDMAIN")[0]?.detail).toBe("CICS LINK");
    for (const e of graph.edges) {
      expect(e.loc.line).toBeGreaterThan(0);
      expect(e.loc.file).toMatch(/\.(cbl|cpy|jcl)$/);
    }
  });

  it("links PERFORM (THRU expands the range), COPY and the data items a copybook defines", () => {
    const thru = graph.edges.filter((e) => e.kind === "PERFORM THRU").map((e) => e.to);
    expect(thru).toEqual(["paragraph:ORDMAIN.2000-EXIT", "paragraph:ORDMAIN.2000-UPDATE"]);
    expect(edge("program:ORDMAIN", "COPY", "copybook:ORDREC")).toHaveLength(1);
    expect(edge("program:ORDMAIN", "COPY", "copybook:NOSUCH")[0]?.detail).toBe("not found");
    expect(edge("copybook:ORDREC", "DEFINES", "data:ORDREC.ORD-REC.ORD-AMT")).toHaveLength(1);
    expect(edge("file:ORDMAIN.ORD-FILE", "RECORD", "data:ORDREC.ORD-REC")).toHaveLength(1);
  });

  it("links file I/O, EXEC SQL tables and EXEC CICS files", () => {
    const ops = graph.edges
      .filter((e) => e.from === "program:ORDMAIN" && e.to === "file:ORDMAIN.ORD-FILE")
      .map((e) => e.kind);
    expect(ops).toEqual(["DELETE", "OPEN", "READ", "REWRITE"]);
    expect(graph.edges.filter((e) => e.kind === "SQL").map((e) => `${e.to}:${e.detail}`)).toEqual([
      "table:CUSTOMER:SELECT",
      "table:CUSTOMER:UPDATE",
      "table:ORDER_HIST:INSERT",
    ]);
    expect(graph.edges.filter((e) => e.kind === "CICS").map((e) => `${e.to}:${e.detail}`)).toEqual([
      "cics-file:CUSTF:READ",
      "cics-file:LOGF:WRITE",
    ]);
    expect(parseCics("EXEC CICS READ DATASET(WS-NAME) INTO(X) END-EXEC")).toMatchObject({
      command: "READ",
      fileDynamic: "WS-NAME",
    });
  });

  it("links jobs, steps, DDs and data sets, and binds a program's SELECT to its DD", () => {
    expect(edge("job:ORDJOB", "STEP", "step:ORDJOB.S10")).toHaveLength(1);
    expect(edge("step:ORDJOB.S10", "EXEC", "program:ORDMAIN")).toHaveLength(1);
    expect(view.node.get("program:IEBGENER")?.kind).toBe("external-program");
    expect(edge("dd:ORDJOB.S10.ORDOUT", "DSN", "dataset:ORDJOB/&&ORDTMP")).toHaveLength(1);
    expect(edge("file:ORDMAIN.OUT-FILE", "ASSIGN", "dd:ORDJOB.S10.ORDOUT")[0]?.loc).toEqual({
      file: "jcl/ORDJOB.jcl",
      line: 4,
    });
  });

  it("is deterministic: the same sources give the same graph", () => {
    const again = buildGraph(buildIndex(root));
    expect(JSON.stringify(again)).toBe(JSON.stringify(graph));
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toEqual(ids.toSorted());
  });
});

describe("CRUD", () => {
  it("derives C/R/U/D per program and target, through DD bindings and JCL DISP", () => {
    const m = crudMatrix(view);
    const cell = (p: string, t: string) => m.cells.get(p)?.get(t)?.join("");
    expect(cell("program:ORDMAIN", "dataset:PROD.ORDMAST")).toBe("RUD");
    expect(cell("program:ORDMAIN", "dataset:ORDJOB/&&ORDTMP")).toBe("C");
    expect(cell("program:ORDMAIN", "table:CUSTOMER")).toBe("RU");
    expect(cell("program:ORDMAIN", "table:ORDER_HIST")).toBe("C");
    expect(cell("program:ORDLOG", "cics-file:CUSTF")).toBe("R");
    expect(cell("program:ORDLOG", "cics-file:LOGF")).toBe("C");
    // A utility step: access from DISP only; DISP=OLD cannot be told apart.
    expect(cell("program:IEBGENER", "dataset:ORDJOB/&&ORDTMP")).toBe("?");
    expect(cell("program:IEBGENER", "dataset:PROD.ORDCOPY")).toBe("C");
    expect(cell("program:ORDRPT", "dataset:PROD.ORDCOPY")).toBe("R");
    for (const a of m.evidence) {
      expect(a.loc.line).toBeGreaterThan(0);
    }
  });
});

describe("graph queries", () => {
  it("lists neighbours with the edge behind each", () => {
    const n = neighbours(view, "dataset:PROD.ORDCOPY");
    expect(n.map((x) => `${x.direction}:${x.edge.kind}:${x.node?.id}`)).toEqual([
      "in:DSN:dd:ORDJOB.S20.SYSUT2",
      "in:DSN:dd:ORDJOB.S30.RPTIN",
    ]);
  });

  it("follows CALL chains down and up, and marks a cycle", () => {
    const down = callChains(view, "program:ORDMAIN");
    expect(down.map((c) => c.nodes.join(">"))).toEqual([
      "program:ORDMAIN>dynamic:ORDMAIN.WS-PGM",
      "program:ORDMAIN>program:EXTUTIL",
      "program:ORDMAIN>program:ORDLOG>program:ORDMAIN",
    ]);
    expect(down[2].cycle).toBe(true);
    const up = callChains(view, "program:ORDLOG", { direction: "up" });
    expect(up[0].nodes).toEqual(["program:ORDLOG", "program:ORDMAIN", "program:ORDLOG"]);
  });

  it("traces data set lineage through a utility step", () => {
    const l = datasetLineage(view, "dataset:PROD.ORDCOPY");
    expect(l.upstream.map((h) => `${h.depth}:${h.program}:${h.dataset}`)).toEqual([
      "1:program:IEBGENER:dataset:PROD.ORDCOPY",
      "2:program:ORDMAIN:dataset:ORDJOB/&&ORDTMP",
    ]);
    expect(l.downstream.map((h) => h.program)).toEqual(["program:ORDRPT"]);
    const deps = programDependencies(view).map((d) => `${d.from}>${d.to}:${d.kind}`);
    expect(deps).toContain("program:ORDRPT>program:ORDMAIN:DATA");
  });

  it("answers graph kinds through legacy_query", () => {
    const env = { stateDir: path.join(root, "state") };
    const chains = legacyQuery(root, "call-chains", { program: "ordmain" }, env) as {
      chains: Array<{ path: string[]; calls: Array<{ file: string; line: number }> }>;
    };
    expect(chains.chains[2].path).toEqual(["ORDMAIN", "ORDLOG", "ORDMAIN"]);
    expect(chains.chains[2].calls[0]).toMatchObject({ file: "cobol/ORDMAIN.cbl" });
    const lineage = legacyQuery(root, "lineage", { dataset: "PROD.ORDCOPY" }, env) as {
      upstream: Array<{ program: string }>;
    };
    expect(lineage.upstream.map((h) => h.program)).toEqual(["IEBGENER", "ORDMAIN"]);
    expect(() => legacyQuery(root, "nope", {}, env)).toThrow(/Known kinds: .*lineage/);
  });
});
