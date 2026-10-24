// Queries over the knowledge graph: neighbours of a node, CALL chains, data set lineage and the
// program-to-program dependencies used by the wave plan. Each result keeps the edges (with
// file:line) that justify it.

import type { GraphEdge, GraphNode, KnowledgeGraph } from "./graph.js";
import type { Loc } from "./types.js";
import { type Access, type GraphView, accesses, producesOrConsumes, viewOf } from "./crud.js";

export type Neighbour = { direction: "out" | "in"; edge: GraphEdge; node: GraphNode | undefined };

/** Resolve a user-supplied name to a node id: an id as is, or a unique name match. */
export function resolveNode(view: GraphView, nameIn: string, kinds?: string[]): string | undefined {
  const name = nameIn.trim();
  if (view.node.has(name)) {
    return name;
  }
  const up = name.toUpperCase();
  const hits = view.graph.nodes.filter(
    (n) => (n.name === up || n.id.endsWith(`:${up}`)) && (!kinds || kinds.includes(n.kind)),
  );
  const order = [
    "program",
    "external-program",
    "dataset",
    "table",
    "cics-file",
    "copybook",
    "job",
    "step",
    "file",
    "paragraph",
    "dd",
    "data-item",
  ];
  hits.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.id < b.id ? -1 : 1));
  return hits[0]?.id;
}

export function neighbours(
  view: GraphView,
  id: string,
  opts: { direction?: "out" | "in" | "both"; kinds?: string[] } = {},
): Neighbour[] {
  const dir = opts.direction ?? "both";
  const ok = (e: GraphEdge) => !opts.kinds || opts.kinds.includes(e.kind);
  const res: Neighbour[] = [];
  if (dir !== "in") {
    for (const e of (view.out.get(id) ?? []).filter(ok)) {
      res.push({ direction: "out", edge: e, node: view.node.get(e.to) });
    }
  }
  if (dir !== "out") {
    for (const e of (view.in.get(id) ?? []).filter(ok)) {
      res.push({ direction: "in", edge: e, node: view.node.get(e.from) });
    }
  }
  return res;
}

export type Chain = { nodes: string[]; edges: GraphEdge[]; cycle?: boolean; truncated?: boolean };

/**
 * CALL chains from a program: every path along CALL edges ("down": what it calls, "up": who
 * calls it), stopping at a repeat (marked as a cycle), a leaf, or `maxDepth`.
 */
export function callChains(
  view: GraphView,
  program: string,
  opts: { direction?: "down" | "up"; maxDepth?: number; maxChains?: number } = {},
): Chain[] {
  const down = (opts.direction ?? "down") === "down";
  const maxDepth = opts.maxDepth ?? 12;
  const maxChains = opts.maxChains ?? 200;
  const chains: Chain[] = [];
  const step = (id: string) =>
    (down ? view.out.get(id) : view.in.get(id))?.filter((e) => e.kind === "CALL") ?? [];
  const walk = (path: string[], edges: GraphEdge[]) => {
    if (chains.length >= maxChains) {
      return;
    }
    const cur = path[path.length - 1];
    const next = step(cur);
    if (next.length === 0 || path.length > maxDepth) {
      if (edges.length > 0) {
        chains.push({ nodes: path, edges, truncated: next.length > 0 || undefined });
      }
      return;
    }
    const seen = new Set<string>();
    for (const e of next) {
      const to = down ? e.to : e.from;
      if (seen.has(to)) {
        continue; // one chain per partner; the first call site stands for the others
      }
      seen.add(to);
      if (path.includes(to)) {
        chains.push({ nodes: [...path, to], edges: [...edges, e], cycle: true });
      } else {
        walk([...path, to], [...edges, e]);
      }
    }
  };
  walk([program], []);
  return chains;
}

export type LineageHop = {
  dataset: string;
  program: string;
  role: "producer" | "consumer";
  access: Access;
  depth: number;
};

/** Producers upstream of a data set and consumers downstream of it, transitively. */
export function datasetLineage(view: GraphView, dataset: string, maxDepth = 8) {
  const acc = accesses(view);
  const producersOf = (ds: string) =>
    acc.filter((a) => a.target === ds && producesOrConsumes(a.op).produces);
  const consumersOf = (ds: string) =>
    acc.filter((a) => a.target === ds && producesOrConsumes(a.op).consumes);
  const upstream: LineageHop[] = [];
  const downstream: LineageHop[] = [];
  // Walk one direction; a data set reached through program P does not list P again (P updating
  // its own input in place, or reading back its own output, is not lineage).
  const walk = (dir: "up" | "down") => {
    const seen = new Set<string>([dataset]);
    let frontier: Array<{ ds: string; via?: string }> = [{ ds: dataset }];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: Array<{ ds: string; via?: string }> = [];
      for (const { ds, via } of frontier) {
        const hops = (dir === "up" ? producersOf(ds) : consumersOf(ds)).filter(
          (a) => a.program !== via,
        );
        for (const a of hops) {
          (dir === "up" ? upstream : downstream).push({
            dataset: ds,
            program: a.program,
            role: dir === "up" ? "producer" : "consumer",
            access: a,
            depth,
          });
          const more = acc.filter(
            (b) =>
              b.program === a.program &&
              (dir === "up"
                ? producesOrConsumes(b.op).consumes
                : producesOrConsumes(b.op).produces),
          );
          for (const b of more) {
            if (!seen.has(b.target)) {
              seen.add(b.target);
              next.push({ ds: b.target, via: a.program });
            }
          }
        }
      }
      frontier = next;
    }
  };
  walk("up");
  walk("down");
  return { dataset, upstream, downstream };
}

export type Dependency = {
  /** The program that depends ... */
  from: string;
  /** ... on this one. */
  to: string;
  kind: "CALL" | "DATA";
  /** For DATA: the data set(s) linking them, and utilities passed through. */
  via: string[];
  evidence: Loc[];
};

/**
 * Program dependencies: A depends on B when A CALLs B (static or CICS LINK/XCTL), or when A
 * reads a data set that B writes (directly, or through utility steps without source, e.g. a
 * SORT between them). Dependencies between programs with source only.
 */
export function programDependencies(view: GraphView): Dependency[] {
  const deps = new Map<string, Dependency>();
  const add = (d: Dependency) => {
    const k = `${d.from}|${d.to}|${d.kind}`;
    const prev = deps.get(k);
    if (prev) {
      prev.via = [...new Set([...prev.via, ...d.via])]; // path order: upstream first
      for (const l of d.evidence) {
        if (!prev.evidence.some((x) => x.file === l.file && x.line === l.line)) {
          prev.evidence.push(l);
        }
      }
    } else {
      deps.set(k, { ...d, via: [...d.via], evidence: [...d.evidence] });
    }
  };
  const isProgram = (id: string) => view.node.get(id)?.kind === "program";
  for (const e of view.graph.edges) {
    if (e.kind === "CALL" && isProgram(e.from) && isProgram(e.to) && e.from !== e.to) {
      add({ from: e.from, to: e.to, kind: "CALL", via: [], evidence: [e.loc] });
    }
  }
  const acc = accesses(view);
  // Producers of a data set, looking through utilities: a utility that consumes X and produces
  // Y makes X's producers producers of Y.
  const producers = (
    ds: string,
    seen: Set<string>,
  ): Array<{ program: string; via: string[]; evidence: Loc[] }> => {
    const res: Array<{ program: string; via: string[]; evidence: Loc[] }> = [];
    for (const p of acc.filter((a) => a.target === ds && producesOrConsumes(a.op).produces)) {
      if (isProgram(p.program)) {
        res.push({ program: p.program, via: [ds], evidence: [p.bind ?? p.loc] });
      } else if (!seen.has(p.program)) {
        seen.add(p.program);
        for (const input of acc.filter(
          (a) => a.program === p.program && a.step === p.step && producesOrConsumes(a.op).consumes,
        )) {
          for (const up of producers(input.target, seen)) {
            res.push({
              program: up.program,
              via: [...up.via, ds],
              evidence: [...up.evidence, input.loc, p.loc],
            });
          }
        }
      }
    }
    return res;
  };
  for (const c of acc.filter((a) => isProgram(a.program) && producesOrConsumes(a.op).consumes)) {
    for (const p of producers(c.target, new Set())) {
      if (p.program !== c.program) {
        add({
          from: c.program,
          to: p.program,
          kind: "DATA",
          via: p.via,
          evidence: [...p.evidence, c.bind ?? c.loc],
        });
      }
    }
  }
  return [...deps.values()].toSorted((a, b) =>
    a.from < b.from
      ? -1
      : a.from > b.from
        ? 1
        : a.to < b.to
          ? -1
          : a.to > b.to
            ? 1
            : a.kind < b.kind
              ? -1
              : 1,
  );
}

export { viewOf };
export type { KnowledgeGraph };

export const GRAPH_QUERY_KINDS = ["graph-neighbours", "call-chains", "lineage"] as const;

/** Tool-facing graph queries: neighbours of a node, CALL chains, data set lineage. */
export function runGraphQuery(graph: KnowledgeGraph, kind: string, args: Record<string, unknown>) {
  const view = viewOf(graph);
  const s = (k: string) => (typeof args[k] === "string" ? args[k].trim() : "");
  const need = (k: string, kinds?: string[]) => {
    const v = s(k);
    if (!v) {
      throw new Error(`Query "${kind}" needs the argument "${k}".`);
    }
    const id = resolveNode(view, v, kinds);
    if (!id) {
      throw new Error(`No graph node matches "${v}".`);
    }
    return id;
  };
  const brief = (n: GraphNode | undefined) =>
    n ? { id: n.id, kind: n.kind, name: n.name } : undefined;
  switch (kind) {
    case "graph-neighbours": {
      const id = need("node");
      const dir = s("direction");
      const direction = dir === "in" || dir === "out" ? dir : "both";
      return {
        node: brief(view.node.get(id)),
        neighbours: neighbours(view, id, { direction }).map((x) => ({
          direction: x.direction,
          edge: x.edge.kind,
          detail: x.edge.detail,
          node: brief(x.node),
          file: x.edge.loc.file,
          line: x.edge.loc.line,
        })),
      };
    }
    case "call-chains": {
      const id = need("program", ["program", "external-program"]);
      const direction = s("direction") === "up" ? "up" : "down";
      return {
        program: id,
        direction,
        chains: callChains(view, id, { direction }).map((c) => ({
          path: c.nodes.map((n) => n.replace(/^[a-z-]+:/, "")),
          cycle: c.cycle,
          truncated: c.truncated,
          calls: c.edges.map((e) => ({ file: e.loc.file, line: e.loc.line, kind: e.detail })),
        })),
      };
    }
    case "lineage": {
      const id = need("dataset", ["dataset", "table", "cics-file", "file"]);
      const l = datasetLineage(view, id);
      const hop = (h: LineageHop) => ({
        dataset: h.dataset,
        program: h.program.replace(/^program:/, ""),
        op: h.access.op,
        via: h.access.via,
        depth: h.depth,
        file: h.access.loc.file,
        line: h.access.loc.line,
        bind: h.access.bind,
      });
      return { dataset: id, upstream: l.upstream.map(hop), downstream: l.downstream.map(hop) };
    }
    default:
      throw new Error(
        `Unknown graph query kind "${kind}". Known kinds: ${GRAPH_QUERY_KINDS.join(", ")}.`,
      );
  }
}
