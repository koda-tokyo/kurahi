// Cross-program knowledge graph, built deterministically from the fact index. Nodes are
// programs, paragraphs, sections, copybooks, data items, logical files, data sets, SQL tables,
// CICS files, jobs, steps and DD statements; every edge carries the file:line of the fact that
// created it. The same index always gives the same graph (nodes and edges are sorted).

import type { DataItem, LegacyIndex, Loc, Program, Statement } from "./types.js";
import { ddNameOf } from "./data.js";
import { allSteps } from "./query.js";

export type NodeKind =
  | "program"
  | "external-program"
  | "dynamic-target"
  | "paragraph"
  | "section"
  | "copybook"
  | "data-item"
  | "file"
  | "dataset"
  | "table"
  | "cics-file"
  | "job"
  | "step"
  | "dd"
  // Java and SQL DDL (polyglot graph, modernise/poly-graph.ts)
  | "java-package"
  | "java-type"
  | "java-method"
  | "column"
  | "sql-index"
  // FORTRAN and PL/I (modernise/sci-graph.ts); their units are "program" nodes with attrs.language
  | "fortran-module"
  | "common-block";

export type GraphNode = {
  id: string;
  kind: NodeKind;
  name: string;
  /** Where the node is defined; absent for things only referenced (external programs). */
  loc?: Loc;
  attrs?: Record<string, string>;
};

export type EdgeKind =
  | "CONTAINS"
  | "CALL"
  | "PERFORM"
  | "PERFORM THRU"
  | "GO TO"
  | "COPY"
  | "DEFINES"
  | "RECORD"
  | "OPEN"
  | "READ"
  | "WRITE"
  | "REWRITE"
  | "DELETE"
  | "START"
  | "SQL"
  | "CICS"
  | "STEP"
  | "EXEC"
  | "DD"
  | "DSN"
  | "ASSIGN"
  // Java and SQL DDL (polyglot graph, modernise/poly-graph.ts)
  | "EXTENDS"
  | "IMPLEMENTS"
  | "INVOKES"
  | "MAPS"
  | "JPA"
  | "FK"
  | "INDEX"
  | "VIEW"
  // FORTRAN (modernise/sci-graph.ts)
  | "USE"
  | "COMMON";

export type GraphEdge = {
  from: string;
  to: string;
  kind: EdgeKind;
  /** The fact behind the edge. */
  loc: Loc;
  /** Paragraph the statement is in, for program-level edges from the PROCEDURE DIVISION. */
  paragraph?: string;
  /** SQL operation, CICS command, OPEN mode, DISP, CALL kind ("static", "dynamic", "CICS LINK"). */
  detail?: string;
  /** Java facts: how the access was found (JDBC SELECT, @Query, EmployeeRepository.save, ...). */
  via?: string;
};

export type KnowledgeGraph = {
  schema: "kurahi.legacy-graph/1";
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export const nodeId = {
  program: (name: string) => `program:${name}`,
  paragraph: (program: string, para: string) => `paragraph:${program}.${para}`,
  section: (program: string, sec: string) => `section:${program}.${sec}`,
  copybook: (name: string) => `copybook:${name}`,
  dataItem: (owner: string, name: string) => `data:${owner}.${name}`,
  file: (program: string, fd: string) => `file:${program}.${fd}`,
  /** Temporary data sets (&&NAME) are scoped to their job. */
  dataset: (dsn: string, job: string) =>
    dsn.startsWith("&&") ? `dataset:${job}/${dsn}` : `dataset:${dsn}`,
  table: (name: string) => `table:${name}`,
  cicsFile: (name: string) => `cics-file:${name}`,
  job: (name: string) => `job:${name}`,
  step: (job: string, step: string) => `step:${job}.${step}`,
  dd: (job: string, step: string, dd: string) => `dd:${job}.${step}.${dd}`,
  dynamic: (program: string, target: string) => `dynamic:${program}.${target}`,
};

const loc = (x: Loc): Loc => ({ file: x.file, line: x.line });

/** CICS command, its FILE/DATASET literal and its PROGRAM literal, from `EXEC CICS ...` code. */
export function parseCics(code: string): {
  command: string;
  file?: string;
  fileDynamic?: string;
  program?: string;
  programDynamic?: string;
} | null {
  const m = /^EXEC\s+CICS\s+([A-Z-]+)/i.exec(code);
  if (!m) {
    return null;
  }
  const opt = (names: string) => {
    const re = new RegExp(
      `\\b(?:${names})\\s*\\(\\s*('([^']*)'|"([^"]*)"|([A-Z0-9#@$-]+))\\s*\\)`,
      "i",
    );
    const r = re.exec(code);
    if (!r) {
      return {};
    }
    const lit = r[2] ?? r[3];
    return lit !== undefined ? { lit: lit.toUpperCase() } : { dyn: r[4].toUpperCase() };
  };
  const f = opt("FILE|DATASET");
  const p = opt("PROGRAM");
  return {
    command: m[1].toUpperCase(),
    file: f.lit,
    fileDynamic: f.dyn,
    program: p.lit,
    programDynamic: p.dyn,
  };
}

class Builder {
  nodes = new Map<string, GraphNode>();
  edges: GraphEdge[] = [];
  private seen = new Set<string>();

  node(n: GraphNode): string {
    if (!this.nodes.has(n.id)) {
      this.nodes.set(n.id, n);
    }
    return n.id;
  }

  edge(e: GraphEdge): void {
    const k = `${e.from}|${e.to}|${e.kind}|${e.loc.file}:${e.loc.line}|${e.detail ?? ""}`;
    if (!this.seen.has(k)) {
      this.seen.add(k);
      this.edges.push(e);
    }
  }
}

function dataOwner(prog: Program, d: DataItem): string {
  return d.copybook ?? prog.name;
}

function addProgram(b: Builder, prog: Program, known: Set<string>): void {
  const pid = b.node({
    id: nodeId.program(prog.name),
    kind: "program",
    name: prog.name,
    loc: loc(prog),
  });
  for (const s of prog.sections.filter((x) => x.division === "PROCEDURE")) {
    const sid = b.node({
      id: nodeId.section(prog.name, s.name),
      kind: "section",
      name: s.name,
      loc: loc(s),
    });
    b.edge({ from: pid, to: sid, kind: "CONTAINS", loc: loc(s) });
  }
  const paraNames = new Set(prog.paragraphs.map((p) => p.name));
  for (const para of prog.paragraphs) {
    const id = b.node({
      id: nodeId.paragraph(prog.name, para.name),
      kind: "paragraph",
      name: para.name,
      loc: loc(para),
      attrs: { program: prog.name, endLine: String(para.endLine) },
    });
    const owner =
      para.section && para.section !== para.name ? nodeId.section(prog.name, para.section) : pid;
    b.edge({ from: owner, to: id, kind: "CONTAINS", loc: loc(para) });
  }
  // Copybooks: a COPY in the program's own file comes from the program; a nested COPY from the
  // copybook whose file holds it.
  const bookOfFile = new Map(
    prog.copies.filter((c) => c.resolved).map((c) => [c.resolved as string, c.name]),
  );
  for (const c of prog.copies) {
    const cid = b.node({
      id: nodeId.copybook(c.name),
      kind: "copybook",
      name: c.name,
      attrs: c.resolved ? { file: c.resolved } : { missing: "true" },
    });
    const from = c.file === prog.file ? pid : nodeId.copybook(bookOfFile.get(c.file) ?? c.name);
    b.edge({
      from,
      to: cid,
      kind: "COPY",
      loc: loc(c),
      detail: c.resolved ? undefined : "not found",
    });
  }
  for (const d of prog.dataItems) {
    if (d.name === "FILLER") {
      continue;
    }
    const owner = dataOwner(prog, d);
    const id = b.node({
      id: nodeId.dataItem(owner, d.path.join(".")),
      kind: "data-item",
      name: d.name,
      loc: loc(d),
      attrs: { level: String(d.level), ...(d.pic ? { pic: d.pic } : {}) },
    });
    b.edge({
      from: d.copybook ? nodeId.copybook(d.copybook) : pid,
      to: id,
      kind: "DEFINES",
      loc: loc(d),
    });
  }
  for (const f of prog.files) {
    const fid = b.node({
      id: nodeId.file(prog.name, f.name),
      kind: "file",
      name: f.name,
      loc: loc(f),
      attrs: {
        program: prog.name,
        ...(f.assign ? { assign: f.assign } : {}),
        ...(f.organization ? { organization: f.organization } : {}),
      },
    });
    for (const r of f.records) {
      const rec = prog.dataItems.find((d) => d.name === r && d.level === 1);
      if (rec) {
        b.edge({
          from: fid,
          to: nodeId.dataItem(dataOwner(prog, rec), rec.name),
          kind: "RECORD",
          loc: loc(rec),
        });
      }
    }
  }
  for (const para of prog.paragraphs) {
    const order = prog.paragraphs.map((p) => p.name);
    const from = nodeId.paragraph(prog.name, para.name);
    for (const st of para.statements) {
      addStatement(b, prog, para.name, from, st, { known, paraNames, order });
    }
  }
}

function addStatement(
  b: Builder,
  prog: Program,
  para: string,
  from: string,
  st: Statement,
  ctx: { known: Set<string>; paraNames: Set<string>; order: string[] },
): void {
  const pid = nodeId.program(prog.name);
  const at = loc(st);
  if (st.performs && !st.performs.inline) {
    const { target, thru } = st.performs;
    if (thru) {
      const a = ctx.order.indexOf(target);
      const z = ctx.order.indexOf(thru);
      for (const to of a >= 0 && z >= a ? ctx.order.slice(a, z + 1) : [target, thru]) {
        b.edge({
          from,
          to: nodeId.paragraph(prog.name, to),
          kind: "PERFORM THRU",
          loc: at,
          detail: `${target} THRU ${thru}`,
        });
      }
    } else {
      b.edge({ from, to: nodeId.paragraph(prog.name, target), kind: "PERFORM", loc: at });
    }
  }
  for (const g of st.goTo ?? []) {
    b.edge({ from, to: nodeId.paragraph(prog.name, g), kind: "GO TO", loc: at });
  }
  if (st.call) {
    addCall(b, prog, para, st.call.target, st.call.dynamic, at, ctx.known, "CALL");
  }
  if (st.io && st.io.op !== "CLOSE") {
    const fd = prog.files.find((f) => f.name === st.io?.file);
    if (fd) {
      b.edge({
        from: pid,
        to: nodeId.file(prog.name, fd.name),
        kind: st.io.op,
        loc: at,
        paragraph: para,
        detail: st.io.mode,
      });
    }
  }
  if (st.sql) {
    const op = st.sql.ops[0] ?? "";
    for (const t of st.sql.tables) {
      b.node({ id: nodeId.table(t), kind: "table", name: t });
      b.edge({ from: pid, to: nodeId.table(t), kind: "SQL", loc: at, paragraph: para, detail: op });
    }
  }
  const cics = st.verb === "EXEC" ? parseCics(st.code) : null;
  if (cics) {
    if (cics.file) {
      b.node({ id: nodeId.cicsFile(cics.file), kind: "cics-file", name: cics.file });
      b.edge({
        from: pid,
        to: nodeId.cicsFile(cics.file),
        kind: "CICS",
        loc: at,
        paragraph: para,
        detail: cics.command,
      });
    }
    if (cics.command === "LINK" || cics.command === "XCTL") {
      const target = cics.program ?? cics.programDynamic;
      if (target) {
        addCall(
          b,
          prog,
          para,
          target,
          cics.program === undefined,
          at,
          ctx.known,
          `CICS ${cics.command}`,
        );
      }
    }
  }
}

function addCall(
  b: Builder,
  prog: Program,
  para: string,
  target: string,
  dynamic: boolean,
  at: Loc,
  known: Set<string>,
  via: string,
): void {
  let to: string;
  if (dynamic) {
    to = b.node({ id: nodeId.dynamic(prog.name, target), kind: "dynamic-target", name: target });
  } else if (known.has(target)) {
    to = nodeId.program(target);
  } else {
    to = b.node({ id: nodeId.program(target), kind: "external-program", name: target });
  }
  b.edge({
    from: nodeId.program(prog.name),
    to,
    kind: "CALL",
    loc: at,
    paragraph: para,
    detail: dynamic ? `${via} dynamic` : via === "CALL" ? "static" : via,
  });
}

export function buildGraph(index: LegacyIndex): KnowledgeGraph {
  const b = new Builder();
  const known = new Set(index.programs.map((p) => p.name));
  for (const c of index.copybooks) {
    b.node({
      id: nodeId.copybook(c.name),
      kind: "copybook",
      name: c.name,
      loc: { file: c.file, line: 1 },
      attrs: { file: c.file },
    });
  }
  for (const p of index.programs) {
    addProgram(b, p, known);
  }
  for (const job of index.jobs) {
    b.node({
      id: nodeId.job(job.name),
      kind: "job",
      name: job.name,
      loc: loc(job),
      attrs: { type: job.kind },
    });
  }
  for (const { job, step, via } of allSteps(index)) {
    const sid = b.node({
      id: nodeId.step(job.name, step.name),
      kind: "step",
      name: step.name,
      loc: loc(step),
      attrs: {
        job: job.name,
        ...(step.program ? { program: step.program } : {}),
        ...(step.proc ? { proc: step.proc } : {}),
        ...(step.cond ? { cond: step.cond } : {}),
        ...(step.parm ? { parm: step.parm } : {}),
        ...(via ? { via } : {}),
      },
    });
    b.edge({ from: nodeId.job(job.name), to: sid, kind: "STEP", loc: loc(step) });
    const prog = step.program ? index.programs.find((p) => p.name === step.program) : undefined;
    if (step.program) {
      const to = prog
        ? nodeId.program(prog.name)
        : b.node({
            id: nodeId.program(step.program),
            kind: "external-program",
            name: step.program,
          });
      b.edge({ from: sid, to, kind: "EXEC", loc: loc(step) });
    }
    for (const dd of step.dds) {
      const did = b.node({
        id: nodeId.dd(job.name, step.name, dd.ddname),
        kind: "dd",
        name: dd.ddname,
        loc: loc(dd),
        attrs: {
          access: dd.access,
          ...(dd.disp ? { disp: dd.disp } : {}),
          ...(dd.sysout !== undefined ? { sysout: dd.sysout } : {}),
        },
      });
      b.edge({ from: sid, to: did, kind: "DD", loc: loc(dd), detail: dd.access });
      if (dd.dsn) {
        const dsid = b.node({
          id: nodeId.dataset(dd.dsn, job.name),
          kind: "dataset",
          name: dd.dsn,
          attrs: dd.dsn.startsWith("&&") ? { temporary: "true", job: job.name } : {},
        });
        b.edge({ from: did, to: dsid, kind: "DSN", loc: loc(dd), detail: dd.access });
      }
      const fd = prog?.files.find((f) => ddNameOf(f.assign) === dd.ddname);
      if (prog && fd) {
        b.edge({ from: nodeId.file(prog.name, fd.name), to: did, kind: "ASSIGN", loc: loc(dd) });
      }
    }
  }
  const byText = (a: string, z: string) => (a < z ? -1 : a > z ? 1 : 0);
  const nodes = [...b.nodes.values()].toSorted((x, y) => byText(x.id, y.id));
  const edges = b.edges.toSorted(
    (x, y) =>
      byText(x.from, y.from) ||
      byText(x.kind, y.kind) ||
      byText(x.to, y.to) ||
      byText(x.loc.file, y.loc.file) ||
      x.loc.line - y.loc.line ||
      byText(x.detail ?? "", y.detail ?? ""),
  );
  return { schema: "kurahi.legacy-graph/1", nodes, edges };
}
