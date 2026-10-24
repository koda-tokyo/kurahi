// CRUD facts: which program creates, reads, updates or deletes which data set, SQL table or
// CICS file, derived from the knowledge graph. A program's file I/O is followed through its
// SELECT ... ASSIGN to the DD statements of the steps that run it, and from there to the data
// set. Programs without source (utilities run by a step) get their access from the DD's DISP
// only, and DISP=OLD is reported as "?" (read or rewrite cannot be told apart from JCL).

import type { GraphEdge, GraphNode, KnowledgeGraph } from "./graph.js";
import type { Loc } from "./types.js";

export type CrudOp = "C" | "R" | "U" | "D" | "?";

export type Access = {
  /** Program node id (program or external-program). */
  program: string;
  target: string;
  op: CrudOp;
  /** The verb or clause behind the access: READ, WRITE, SQL INSERT, CICS READ, DISP=SHR, ... */
  via: string;
  loc: Loc;
  /** The DD statement that binds the program's file to the data set, when there is one. */
  bind?: Loc;
  step?: string;
  paragraph?: string;
};

const IO_OPS: Record<string, CrudOp> = {
  READ: "R",
  START: "R",
  WRITE: "C",
  REWRITE: "U",
  DELETE: "D",
};

const SQL_OPS: Record<string, CrudOp[]> = {
  SELECT: ["R"],
  DECLARE: ["R"],
  FETCH: ["R"],
  OPEN: ["R"],
  INSERT: ["C"],
  UPDATE: ["U"],
  DELETE: ["D"],
  MERGE: ["C", "U"],
  WITH: ["R"],
  TRUNCATE: ["D"],
};

const CICS_OPS: Record<string, CrudOp> = {
  READ: "R",
  READNEXT: "R",
  READPREV: "R",
  STARTBR: "R",
  WRITE: "C",
  REWRITE: "U",
  DELETE: "D",
};

export type GraphView = {
  graph: KnowledgeGraph;
  node: Map<string, GraphNode>;
  out: Map<string, GraphEdge[]>;
  in: Map<string, GraphEdge[]>;
};

/** Adjacency maps over a graph (edges keep the graph's deterministic order). */
export function viewOf(graph: KnowledgeGraph): GraphView {
  const node = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, GraphEdge[]>();
  const inn = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    out.set(e.from, [...(out.get(e.from) ?? []), e]);
    inn.set(e.to, [...(inn.get(e.to) ?? []), e]);
  }
  return { graph, node, out, in: inn };
}

const ORDER: CrudOp[] = ["C", "R", "U", "D", "?"];

export function accesses(view: GraphView): Access[] {
  const out: Access[] = [];
  for (const e of view.graph.edges) {
    const from = view.node.get(e.from);
    if (!from) {
      continue;
    }
    if (from.kind === "program" && IO_OPS[e.kind]) {
      // File I/O: follow ASSIGN -> DD -> DSN; without a binding the logical file is the target.
      const binds = (view.out.get(e.to) ?? []).filter((x) => x.kind === "ASSIGN");
      const dsns = binds.flatMap((bnd) =>
        (view.out.get(bnd.to) ?? [])
          .filter((x) => x.kind === "DSN")
          .map((x) => ({
            dsn: x.to,
            bind: bnd.loc,
            step: (view.in.get(bnd.to) ?? []).find((y) => y.kind === "DD")?.from,
          })),
      );
      const base = {
        program: e.from,
        op: IO_OPS[e.kind],
        via: e.kind,
        loc: e.loc,
        paragraph: e.paragraph,
      };
      if (dsns.length === 0) {
        out.push({ ...base, target: e.to });
      }
      for (const d of dsns) {
        out.push({ ...base, target: d.dsn, bind: d.bind, step: d.step });
      }
    } else if (e.kind === "SQL") {
      for (const op of SQL_OPS[e.detail ?? ""] ?? ["?"]) {
        out.push({
          program: e.from,
          target: e.to,
          op,
          via: e.via ?? `SQL ${e.detail ?? ""}`.trim(),
          loc: e.loc,
          paragraph: e.paragraph,
        });
      }
    } else if (e.kind === "JPA") {
      // Java repository access: the operations are in `detail` ("C,U"), the method in `via`.
      for (const op of (e.detail ?? "?").split(",") as CrudOp[]) {
        out.push({
          program: e.from,
          target: e.to,
          op,
          via: e.via ?? "JPA",
          loc: e.loc,
          paragraph: e.paragraph,
        });
      }
    } else if (e.kind === "CICS") {
      const op = CICS_OPS[e.detail ?? ""];
      if (op) {
        out.push({
          program: e.from,
          target: e.to,
          op,
          via: `CICS ${e.detail}`,
          loc: e.loc,
          paragraph: e.paragraph,
        });
      }
    } else if (e.kind === "EXEC" && view.node.get(e.to)?.kind === "external-program") {
      // A step that runs a program without source: its data sets from the DD's DISP.
      for (const dd of (view.out.get(e.from) ?? []).filter((x) => x.kind === "DD")) {
        const ddNode = view.node.get(dd.to);
        const dsn = (view.out.get(dd.to) ?? []).find((x) => x.kind === "DSN");
        const access = ddNode?.attrs?.access;
        const op: CrudOp | undefined =
          access === "input"
            ? "R"
            : access === "output"
              ? "C"
              : access === "exclusive"
                ? "?"
                : undefined;
        if (dsn && op) {
          out.push({
            program: e.to,
            target: dsn.to,
            op,
            via: `DISP=${ddNode?.attrs?.disp ?? ""} (${ddNode?.name})`,
            loc: dd.loc,
            step: e.from,
          });
        }
      }
    }
  }
  return out;
}

export type CrudMatrix = {
  programs: string[];
  targets: string[];
  /** cells[program][target] = the operations, in C R U D ? order. */
  cells: Map<string, Map<string, CrudOp[]>>;
  evidence: Access[];
};

export function crudMatrix(view: GraphView): CrudMatrix {
  const evidence = accesses(view);
  const cells = new Map<string, Map<string, CrudOp[]>>();
  for (const a of evidence) {
    const row = cells.get(a.program) ?? new Map<string, CrudOp[]>();
    const ops = new Set(row.get(a.target) ?? []);
    ops.add(a.op);
    row.set(
      a.target,
      ORDER.filter((o) => ops.has(o)),
    );
    cells.set(a.program, row);
  }
  const programs = [...cells.keys()].toSorted();
  const targets = [...new Set(evidence.map((a) => a.target))].toSorted();
  return { programs, targets, cells, evidence };
}

/** Producers write (C, U); consumers read (R) or may read ("?"). */
export function producesOrConsumes(op: CrudOp): { produces: boolean; consumes: boolean } {
  return { produces: op === "C" || op === "U", consumes: op === "R" || op === "?" };
}
