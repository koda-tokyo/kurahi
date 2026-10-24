// Cross-language impact of changing a table, a column, a data set or file, a COMMON block, a
// FORTRAN module, a Java type or a program (COBOL, FORTRAN, PL/I), over the polyglot graph: who
// reads or writes it (COBOL and PL/I EXEC SQL and file I/O, FORTRAN file I/O, Java JPA/JDBC,
// utilities through JCL), the objects tied to it (views, foreign keys, indexes, entity and column
// mappings, units sharing the COMMON block or using the module), and everything upstream that
// reaches an accessor (Java callers through resolved calls, CALL callers in any language, job
// steps that run the programs). Every entry carries the fact's file:line; nothing is inferred
// beyond the edges of the graph.

import type { GraphEdge, GraphNode, KnowledgeGraph } from "../graph.js";
import type { Polyglot } from "./project.js";
import { type CrudOp, type GraphView, accesses, viewOf } from "../crud.js";

export type ImpactEntry = {
  node: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  detail?: string;
};

export type CrossImpact = {
  query: string;
  target?: { id: string; kind: string; name: string; file?: string; line?: number };
  found: boolean;
  accessors: Array<ImpactEntry & { ops: CrudOp[]; via: string; where?: string }>;
  schema: Array<ImpactEntry & { relation: string }>;
  /** SQL text that names the column (columns only): textual match, listed for review. */
  mentions: Array<{ file: string; line: number; owner: string; text: string }>;
  callers: Array<ImpactEntry & { depth: number; reaches: string; edge: string }>;
  languages: string[];
  truncated: boolean;
};

const MAX_DEPTH = 8;
const MAX_CALLERS = 500;

function language(n: GraphNode | undefined): string {
  if (n?.attrs?.language) {
    return n.attrs.language;
  }
  switch (n?.kind) {
    case "java-type":
    case "java-method":
      return "Java";
    case "program":
    case "external-program":
    case "paragraph":
      return "COBOL";
    case "step":
    case "job":
      return "JCL";
    case "table":
    case "column":
    case "sql-index":
      return "SQL";
    case "common-block":
    case "fortran-module":
      return "FORTRAN";
    default:
      return "other";
  }
}

/**
 * A table, TABLE.COLUMN, a Java type (simple or qualified name), a program, a COMMON block
 * (`/GRID/`), a FORTRAN module or a data set / file name, as a node id.
 */
export function resolveTarget(view: GraphView, q: string): string | undefined {
  const s = q.trim();
  if (view.node.has(s)) {
    return s;
  }
  const up = s.toUpperCase();
  const block = /^\/(.*)\/$/.exec(up);
  if (block) {
    const id = `common:${block[1] === "" ? "(blank)" : block[1]}`;
    return view.node.has(id) ? id : undefined;
  }
  for (const id of [
    `table:${up}`,
    `column:${up}`,
    `program:${up}`,
    `type:${s}`,
    `module:${up}`,
    `common:${up}`,
    `dataset:${s}`,
    `dataset:${up}`,
  ]) {
    if (view.node.has(id)) {
      return id;
    }
  }
  const types = view.graph.nodes.filter(
    (n) => n.kind === "java-type" && !n.attrs?.external && (n.name === s || n.id.endsWith(`.${s}`)),
  );
  return types.length === 1 ? types[0].id : undefined;
}

export function crossImpact(poly: Polyglot, graph: KnowledgeGraph, query: string): CrossImpact {
  const view = viewOf(graph);
  const id = resolveTarget(view, query);
  const empty: CrossImpact = {
    query,
    found: false,
    accessors: [],
    schema: [],
    mentions: [],
    callers: [],
    languages: [],
    truncated: false,
  };
  if (!id) {
    return empty;
  }
  const n = view.node.get(id) as GraphNode;
  const entry = (nid: string, e: GraphEdge, detail?: string): ImpactEntry => {
    const x = view.node.get(nid);
    return {
      node: nid,
      name: x?.name ?? nid,
      kind: x?.kind ?? "unknown",
      file: e.loc.file,
      line: e.loc.line,
      ...(detail ? { detail } : {}),
    };
  };
  const out: CrossImpact = {
    ...empty,
    found: true,
    target: {
      id,
      kind: n.kind,
      name: n.name,
      ...(n.loc ? { file: n.loc.file, line: n.loc.line } : {}),
    },
  };
  const table =
    n.kind === "column" ? `table:${n.attrs?.table}` : n.kind === "table" ? id : undefined;
  const column = n.kind === "column" ? n.name : undefined;
  const data = table ?? (n.kind === "dataset" || n.kind === "file" ? id : undefined);
  const all = accesses(view);

  // Accessors: of the table (a column's accessors are its table's) or data set, or of the
  // type / program.
  const own = all.filter((a) => (data ? a.target === data : a.program === id));
  const grouped = new Map<string, (typeof out.accessors)[number]>();
  for (const a of own) {
    const key = `${a.program}|${a.target}|${a.via}|${a.loc.file}:${a.loc.line}`;
    const g = grouped.get(key);
    if (g) {
      g.ops = (["C", "R", "U", "D", "?"] as CrudOp[]).filter(
        (o) => g.ops.includes(o) || o === a.op,
      );
      continue;
    }
    const subject = data ? a.program : a.target;
    const x = view.node.get(subject);
    grouped.set(key, {
      node: subject,
      name: x?.name ?? subject,
      kind: x?.kind ?? "unknown",
      file: a.loc.file,
      line: a.loc.line,
      ops: [a.op],
      via: a.via,
      ...(a.paragraph ? { where: a.paragraph } : {}),
    });
  }
  out.accessors = [...grouped.values()];

  // Schema objects tied to the table or column, and Java mappings.
  if (table) {
    for (const e of view.in.get(table) ?? []) {
      const rel =
        e.kind === "VIEW"
          ? "view reads it"
          : e.kind === "FK"
            ? "foreign key references it"
            : e.kind === "INDEX"
              ? "index on it"
              : e.kind === "MAPS"
                ? "mapped by"
                : undefined;
      if (rel && (!column || e.kind !== "INDEX" || (e.detail ?? "").split(",").includes(column))) {
        if (!column || e.kind !== "FK" || new RegExp(`\\b${column}\\b`).test(e.detail ?? "")) {
          out.schema.push({ ...entry(e.from, e, e.detail), relation: rel });
        }
      }
    }
    for (const e of view.out.get(table) ?? []) {
      if (e.kind === "FK" && (!column || (e.detail ?? "").startsWith(column))) {
        out.schema.push({ ...entry(e.to, e, e.detail), relation: "references (foreign key)" });
      }
      if (e.kind === "VIEW" && !column) {
        out.schema.push({ ...entry(e.to, e, e.detail), relation: "view source" });
      }
    }
  }
  if (column) {
    for (const e of view.in.get(id) ?? []) {
      if (e.kind === "MAPS") {
        out.schema.push({ ...entry(e.from, e, e.detail), relation: "field mapped to the column" });
      }
    }
    const word = new RegExp(`\\b${column}\\b`, "i");
    const tname = n.attrs?.table ?? "";
    for (const u of poly.java.tableUses) {
      if (u.table === tname && u.text && word.test(u.text)) {
        out.mentions.push({ file: u.file, line: u.line, owner: u.type, text: u.text });
      }
    }
    for (const p of poly.index.programs) {
      for (const para of p.paragraphs) {
        for (const st of para.statements) {
          if (st.sql?.tables.includes(tname) && word.test(st.code)) {
            out.mentions.push({ file: st.file, line: st.line, owner: p.name, text: st.code });
          }
        }
      }
    }
  }
  if (n.kind === "java-type") {
    for (const e of view.in.get(id) ?? []) {
      if (e.kind === "EXTENDS" || e.kind === "IMPLEMENTS") {
        out.schema.push({
          ...entry(e.from, e),
          relation: e.kind === "EXTENDS" ? "subclass" : "implementation",
        });
      }
    }
  }

  // FORTRAN: the units sharing a COMMON block or using a module.
  if (n.kind === "common-block" || n.kind === "fortran-module") {
    for (const e of view.in.get(id) ?? []) {
      if (e.kind === "COMMON" || e.kind === "USE") {
        out.schema.push({
          ...entry(e.from, e, e.detail),
          relation: e.kind === "COMMON" ? "shares the COMMON block" : "uses the module",
        });
      }
    }
  }

  // Upstream: Java callers (method -> method or type), CALL callers, steps that run programs.
  const typeOfMethod = (mid: string) => view.node.get(mid)?.attrs?.type;
  const sharing = n.kind === "common-block" || n.kind === "fortran-module";
  const seeds = new Set(
    data ? out.accessors.map((a) => a.node) : sharing ? out.schema.map((x) => x.node) : [id],
  );
  const seen = new Set(seeds);
  let frontier = [...seeds];
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const node = view.node.get(cur);
      const incoming: Array<{ from: string; e: GraphEdge }> = [];
      if (node?.kind === "java-type") {
        const qn = cur.slice("type:".length);
        const targets = [
          cur,
          ...(view.out.get(cur) ?? [])
            .filter((e) => e.kind === "CONTAINS" && e.to.startsWith("method:"))
            .map((e) => e.to),
        ];
        for (const t of targets) {
          for (const e of view.in.get(t) ?? []) {
            const caller = typeOfMethod(e.from);
            if (e.kind === "INVOKES" && caller && caller !== qn) {
              incoming.push({ from: `type:${caller}`, e });
            }
          }
        }
      } else {
        for (const e of view.in.get(cur) ?? []) {
          if (e.kind === "CALL" || e.kind === "EXEC" || e.kind === "STEP") {
            incoming.push({ from: e.from, e });
          }
        }
      }
      for (const { from, e } of incoming) {
        if (seen.has(from)) {
          continue;
        }
        if (out.callers.length >= MAX_CALLERS) {
          out.truncated = true;
          break;
        }
        seen.add(from);
        next.push(from);
        out.callers.push({
          ...entry(from, e, e.detail),
          depth,
          reaches: view.node.get(cur)?.name ?? cur,
          edge:
            e.kind === "INVOKES"
              ? `${view.node.get(e.from)?.name ?? ""} -> ${view.node.get(e.to)?.name ?? ""}`
              : e.kind,
        });
      }
    }
    frontier = next;
  }
  const langs = new Set<string>([language(n)]);
  for (const x of [...out.accessors, ...out.schema, ...out.callers]) {
    langs.add(language(view.node.get(x.node)));
  }
  out.languages = [...langs].filter((l) => l !== "other").toSorted();
  return out;
}
