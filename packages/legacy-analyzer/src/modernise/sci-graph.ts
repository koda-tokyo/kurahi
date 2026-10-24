// FORTRAN and PL/I in the polyglot knowledge graph, with the COBOL graph's conventions. Program
// units and external procedures are `program:NAME` nodes (attrs.language FORTRAN / PL/I), so a
// JCL step's EXEC PGM=, a COBOL CALL and a FORTRAN or PL/I CALL of the same name meet in one
// node, and the CRUD matrix reads their file I/O and EXEC SQL like COBOL's. PL/I internal
// procedures are paragraph nodes of their external procedure; FORTRAN module and internal
// procedures are `program:HOST.NAME`. COMMON blocks are `common:NAME` nodes with their members as
// data items; files are bound to JCL DD statements of the steps that run the program (PL/I: the
// file's DD name; FORTRAN: FTnnF001 for units reached from the executed program).

import type { GraphEdge, GraphNode } from "../graph.js";
import type { Loc } from "../types.js";
import type { Polyglot } from "./project.js";
import { nodeId } from "../graph.js";
import { memberText } from "./fortran-resolve.js";

const loc = (x: Loc): Loc => ({ file: x.file, line: x.line });

export const sciId = {
  module: (name: string) => `module:${name}`,
  common: (name: string) => `common:${name.replace(/^\/\/$/, "(blank)")}`,
  member: (block: string, name: string) => `data:/${block.replace(/^\/\/$/, "")}/.${name}`,
  pliProc: (qn: string) => `paragraph:${qn}`,
};

const IO_EDGE: Record<string, GraphEdge["kind"] | undefined> = {
  OPEN: "OPEN",
  READ: "READ",
  GET: "READ",
  WRITE: "WRITE",
  PUT: "WRITE",
  LOCATE: "WRITE",
  REWRITE: "REWRITE",
  DELETE: "DELETE",
};

export function addFortranPli(
  poly: Polyglot,
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
): void {
  const node = (n: GraphNode) => {
    if (!nodes.has(n.id)) {
      nodes.set(n.id, n);
    }
    return n.id;
  };
  /** A program node with source: replaces an external-program placeholder, keeps a COBOL one. */
  const program = (id: string, n: Omit<GraphNode, "id" | "kind">) => {
    const prev = nodes.get(id);
    if (!prev || prev.kind === "external-program") {
      nodes.set(id, { id, kind: "program", ...n });
    }
    return id;
  };
  const target = (name: string) =>
    node({ id: nodeId.program(name), kind: "external-program", name });
  const execs = (prog: string) =>
    edges.filter((e) => e.kind === "EXEC" && e.to === prog).map((e) => e.from);
  const ddsOf = (step: string, dd: string) =>
    edges.filter((e) => e.kind === "DD" && e.from === step && nodes.get(e.to)?.name === dd);

  // ---------------------------------------------------------------- FORTRAN
  const f = poly.fortran;
  const unitNode = (id: string) => {
    const u = f.units.find((x) => x.id === id);
    return u?.kind === "module" ? sciId.module(id) : nodeId.program(id);
  };
  for (const u of f.units) {
    const attrs = {
      language: "FORTRAN",
      unit: u.kind,
      endLine: String(u.endLine),
      ...(u.host ? { host: u.host } : {}),
    };
    const id =
      u.kind === "module"
        ? (nodes.set(sciId.module(u.id), {
            id: sciId.module(u.id),
            kind: "fortran-module",
            name: u.id,
            loc: loc(u),
            attrs,
          }),
          sciId.module(u.id))
        : program(nodeId.program(u.id), { name: u.id, loc: loc(u), attrs });
    if (u.host) {
      edges.push({ from: unitNode(u.host), to: id, kind: "CONTAINS", loc: loc(u) });
    }
  }
  for (const c of f.calls) {
    const to = c.resolution === "not in the FORTRAN sources" ? target(c.to) : nodeId.program(c.to);
    edges.push({
      from: unitNode(c.from),
      to,
      kind: "CALL",
      loc: loc(c),
      detail: c.form === "call" ? "static" : "function",
      via: `FORTRAN ${c.resolution}`,
    });
  }
  for (const x of f.uses) {
    const to = node({
      id: sciId.module(x.module),
      kind: "fortran-module",
      name: x.module,
      attrs: { external: "true", ...(x.intrinsic ? { intrinsic: "true" } : {}) },
    });
    edges.push({ from: unitNode(x.unit), to, kind: "USE", loc: loc(x) });
  }
  for (const inc of f.includes) {
    const to = node({
      id: nodeId.copybook(inc.name.toUpperCase()),
      kind: "copybook",
      name: inc.name.toUpperCase(),
      ...(inc.resolved ? { loc: { file: inc.resolved, line: 1 } } : {}),
      attrs: { language: "FORTRAN" },
    });
    edges.push({
      from: unitNode(inc.unit),
      to,
      kind: "COPY",
      loc: loc(inc),
      detail: inc.resolved ? "INCLUDE" : "not found",
    });
  }
  for (const b of f.commons) {
    const bid = node({
      id: sciId.common(b.name),
      kind: "common-block",
      name: `/${b.name === "//" ? "" : b.name}/`,
      loc: loc(b.users[0]),
      attrs: { language: "FORTRAN", layout: b.layout, users: String(b.users.length) },
    });
    for (const u of b.users) {
      edges.push({
        from: unitNode(u.unit),
        to: bid,
        kind: "COMMON",
        loc: loc(u),
        detail: u.members.map(memberText).join(", "),
      });
      u.members.forEach((m, k) => {
        const mid = node({
          id: sciId.member(b.name, m.name),
          kind: "data-item",
          name: m.name,
          loc: loc(u),
          attrs: { block: b.name, position: String(k + 1), type: m.type },
        });
        edges.push({ from: bid, to: mid, kind: "CONTAINS", loc: loc(u) });
      });
    }
  }
  // Units reached from each executed program (static calls), for FTnnF001 DD binding.
  const callees = new Map<string, string[]>();
  for (const c of f.calls.filter((x) => x.resolution !== "not in the FORTRAN sources")) {
    callees.set(c.from, [...(callees.get(c.from) ?? []), c.to]);
  }
  const reach = (start: string) => {
    const seen = new Set([start]);
    const todo = [start];
    while (todo.length > 0) {
      for (const n of callees.get(todo.pop() as string) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          todo.push(n);
        }
      }
    }
    return seen;
  };
  const executed = f.units
    .filter((u) => !u.host && u.kind !== "module")
    .flatMap((u) => execs(nodeId.program(u.id)).map((step) => ({ step, units: reach(u.id) })));
  for (const io of f.fileUses) {
    const kind = IO_EDGE[io.op];
    if (!kind) {
      continue;
    }
    let to: string;
    if (io.target.kind === "file") {
      to = node({
        id: `dataset:${io.target.name}`,
        kind: "dataset",
        name: io.target.name,
        attrs: { via: "FORTRAN OPEN FILE=" },
      });
    } else {
      to = node({
        id: nodeId.file(io.unit, io.target.name),
        kind: "file",
        name: io.target.name,
        attrs: { program: io.unit, language: "FORTRAN" },
      });
      for (const ex of executed.filter((x) => x.units.has(io.unit))) {
        for (const dd of ddsOf(ex.step, io.target.name)) {
          edges.push({ from: to, to: dd.to, kind: "ASSIGN", loc: dd.loc });
        }
      }
    }
    edges.push({
      from: unitNode(io.unit),
      to,
      kind,
      loc: loc(io),
      detail: io.op === "OPEN" ? (io.status ?? "OPEN") : io.binding,
    });
  }

  // ---------------------------------------------------------------- PL/I
  const p = poly.pli;
  const outer = (qn: string) => qn.split(".")[0];
  const para = (qn: string) => (qn.includes(".") ? qn.slice(qn.lastIndexOf(".") + 1) : undefined);
  const procNode = (qn: string) => (qn.includes(".") ? sciId.pliProc(qn) : nodeId.program(qn));
  for (const x of p.procs) {
    const attrs = {
      language: "PL/I",
      endLine: String(x.endLine),
      ...(x.main ? { main: "true" } : {}),
    };
    if (!x.parent) {
      program(nodeId.program(x.name), { name: x.name, loc: loc(x), attrs });
      continue;
    }
    const id = node({
      id: sciId.pliProc(x.qualified),
      kind: "paragraph",
      name: x.name,
      loc: loc(x),
      attrs: { ...attrs, procedure: "true", program: outer(x.qualified) },
    });
    edges.push({ from: procNode(x.parent), to: id, kind: "CONTAINS", loc: loc(x) });
  }
  const at = (qn: string) => {
    const pr = para(qn);
    return pr ? { paragraph: pr } : {};
  };
  for (const c of p.calls) {
    const internal = c.resolution === "internal";
    edges.push({
      from: nodeId.program(outer(c.from)),
      to: internal
        ? sciId.pliProc(c.to)
        : c.resolution === "external procedure"
          ? nodeId.program(c.to)
          : target(c.to),
      kind: "CALL",
      loc: loc(c),
      detail: internal ? "internal" : "static",
      via: `PL/I ${c.resolution}`,
      ...at(c.from),
    });
  }
  for (const inc of p.includes) {
    const to = node({
      id: nodeId.copybook(inc.name),
      kind: "copybook",
      name: inc.name,
      ...(inc.resolved ? { loc: { file: inc.resolved, line: 1 } } : {}),
      attrs: { language: "PL/I" },
    });
    edges.push({
      from: nodeId.program(outer(inc.proc)),
      to,
      kind: "COPY",
      loc: loc(inc),
      detail: inc.resolved ? "%INCLUDE" : "not found",
    });
  }
  for (const s of p.structures) {
    const owner = outer(s.proc);
    for (const d of [s.root, ...s.members]) {
      const id = node({
        id: nodeId.dataItem(owner, d.path.join(".")),
        kind: "data-item",
        name: d.name,
        loc: loc(d),
        attrs: {
          level: String(d.level),
          ...(d.type ? { type: d.type } : {}),
          ...(d.storage.length ? { storage: d.storage.join(" ") } : {}),
          language: "PL/I",
        },
      });
      const parent =
        d.path.length > 1
          ? nodeId.dataItem(owner, d.path.slice(0, -1).join("."))
          : nodeId.program(owner);
      edges.push({
        from: parent,
        to: id,
        kind: d.path.length > 1 ? "CONTAINS" : "DEFINES",
        loc: loc(d),
      });
    }
  }
  for (const io of p.fileUses) {
    const kind = IO_EDGE[io.verb];
    if (!kind) {
      continue;
    }
    const fid = node({
      id: nodeId.file(io.program, io.fileName),
      kind: "file",
      name: io.fileName,
      ...(io.declared ? { loc: loc(io.declared) } : {}),
      attrs: {
        program: io.program,
        language: "PL/I",
        dd: io.dd,
        ...(io.declared ? { attrs: io.declared.attrs.join(" ") } : { declared: "false" }),
      },
    });
    edges.push({
      from: nodeId.program(io.program),
      to: fid,
      kind,
      loc: loc(io),
      ...(io.verb === "OPEN"
        ? { detail: io.mode ?? "" }
        : io.verb !== kind
          ? { detail: io.verb }
          : {}),
      ...at(io.proc),
    });
  }
  const bound = new Set<string>();
  for (const io of p.fileUses) {
    const fid = nodeId.file(io.program, io.fileName);
    if (bound.has(fid)) {
      continue;
    }
    bound.add(fid);
    for (const step of execs(nodeId.program(io.program))) {
      for (const dd of ddsOf(step, io.dd)) {
        edges.push({ from: fid, to: dd.to, kind: "ASSIGN", loc: dd.loc });
      }
    }
  }
  for (const t of p.tableUses) {
    const tid = node({
      id: nodeId.table(t.table),
      kind: "table",
      name: t.table,
      attrs: { defined: "not in the analysed DDL" },
    });
    edges.push({
      from: nodeId.program(t.program),
      to: tid,
      kind: "SQL",
      loc: loc(t),
      detail: t.op,
      ...at(t.proc),
    });
  }
}
