// Modernisation wave plan: a proposal, computed from the knowledge graph, for the order in which
// programs could be migrated. A program depends on the programs it CALLs and on the programs
// whose output data sets it reads; programs in a dependency cycle (a strongly connected
// component) move together; a program's wave is one more than the latest wave it depends on;
// inside a wave, lower risk comes first. Risk is a documented points formula over size,
// complexity and coupling facts. Every figure keeps the source lines behind it. It is a starting
// point for people to review, not a decision.

import type { LegacyIndex, Loc, Program } from "./types.js";
import { type Coverage, coverage } from "./coverage.js";
import { type GraphView, accesses, producesOrConsumes, viewOf } from "./crud.js";
import { type Dependency, programDependencies } from "./graph-query.js";
import { buildGraph } from "./graph.js";
import { rulesForProgram } from "./rules.js";

export type ProgramMetrics = {
  program: string;
  loc: Loc;
  paragraphs: number;
  statements: number;
  decisions: number;
  goTo: number;
  alter: number;
  callsOut: number;
  callers: number;
  dynamicCalls: number;
  unresolvedCalls: number;
  sql: number;
  cics: number;
  datasets: number;
  copybooks: number;
  rules: number;
};

export type RiskFactorKind =
  | "size"
  | "decisions"
  | "goTo"
  | "alter"
  | "dynamicCalls"
  | "unresolvedCalls"
  | "fanIn"
  | "sharedOutputs"
  | "sql"
  | "cics"
  | "missingCopybooks";

export type RiskFactor = { factor: RiskFactorKind; count: number; points: number; evidence: Loc[] };
export type RiskBand = "low" | "medium" | "high";
export type ProgramRisk = { program: string; score: number; band: RiskBand; factors: RiskFactor[] };

export type Coupling = {
  a: string;
  b: string;
  calls: Loc[];
  datasets: string[];
  dataEvidence: Loc[];
  copybooks: string[];
  copyEvidence: Loc[];
  weight: number;
};

export type WaveGroup = { programs: string[]; cycle: boolean; score: number; band: RiskBand };
export type Wave = { number: number; groups: WaveGroup[] };

export type WavePlan = {
  schema: "kurahi.legacy-wave-plan/1";
  metrics: ProgramMetrics[];
  risks: ProgramRisk[];
  dependencies: Dependency[];
  cycles: string[][];
  clusters: string[][];
  couplings: Coupling[];
  waves: Wave[];
  waveOf: Record<string, number>;
  outOfScope: Array<{ name: string; kind: "external" | "dynamic"; evidence: Loc[] }>;
  coverage: Coverage;
};

const BANDS: Array<[number, RiskBand]> = [
  [3, "low"],
  [7, "medium"],
];

export function riskBand(score: number): RiskBand {
  return BANDS.find(([max]) => score <= max)?.[1] ?? "high";
}

const bare = (id: string) => id.replace(/^program:/, "");

function statementsOf(p: Program) {
  return p.paragraphs.flatMap((x) => x.statements);
}

function metricsOf(p: Program, view: GraphView, files: Set<string>): ProgramMetrics {
  const st = statementsOf(p);
  const pid = `program:${p.name}`;
  const out = view.out.get(pid) ?? [];
  const calls = out.filter((e) => e.kind === "CALL");
  return {
    program: p.name,
    loc: { file: p.file, line: p.line },
    paragraphs: p.paragraphs.length,
    statements: st.length,
    decisions: st.filter(
      (x) =>
        x.verb === "IF" ||
        x.verb === "SEARCH" ||
        (x.verb === "WHEN" && x.code !== "WHEN OTHER") ||
        (x.verb === "PERFORM" && x.performs?.until !== undefined),
    ).length,
    goTo: st.filter((x) => x.verb === "GO").length,
    alter: st.filter((x) => x.verb === "ALTER").length,
    callsOut: new Set(calls.map((e) => e.to)).size,
    callers: new Set(
      (view.in.get(pid) ?? [])
        .filter((e) => e.kind === "CALL" && e.from !== pid)
        .map((e) => e.from),
    ).size,
    dynamicCalls: calls.filter((e) => view.node.get(e.to)?.kind === "dynamic-target").length,
    unresolvedCalls: calls.filter((e) => view.node.get(e.to)?.kind === "external-program").length,
    sql: out.filter((e) => e.kind === "SQL").length,
    cics: st.filter((x) => x.verb === "EXEC" && /^EXEC\s+CICS\b/.test(x.code)).length,
    datasets: files.size,
    copybooks: new Set(p.copies.map((c) => c.name)).size,
    rules: rulesForProgram(p).length,
  };
}

function riskOf(p: Program, m: ProgramMetrics, view: GraphView, sharedOut: Loc[]): ProgramRisk {
  const pid = `program:${p.name}`;
  const st = statementsOf(p);
  const calls = (view.out.get(pid) ?? []).filter((e) => e.kind === "CALL");
  const locs = (pred: (x: (typeof st)[number]) => boolean) =>
    st.filter(pred).map((x) => ({ file: x.file, line: x.line }));
  const factors: RiskFactor[] = [
    {
      factor: "size",
      count: m.statements,
      points: m.statements > 200 ? 2 : m.statements > 50 ? 1 : 0,
      evidence: [m.loc],
    },
    {
      factor: "decisions",
      count: m.decisions,
      points: Math.min(4, Math.floor(m.decisions / 10)),
      evidence: [m.loc],
    },
    {
      factor: "goTo",
      count: m.goTo,
      points: Math.min(3, m.goTo),
      evidence: locs((x) => x.verb === "GO"),
    },
    {
      factor: "alter",
      count: m.alter,
      points: 3 * m.alter,
      evidence: locs((x) => x.verb === "ALTER"),
    },
    {
      factor: "dynamicCalls",
      count: m.dynamicCalls,
      points: Math.min(6, 3 * m.dynamicCalls),
      evidence: calls
        .filter((e) => view.node.get(e.to)?.kind === "dynamic-target")
        .map((e) => e.loc),
    },
    {
      factor: "unresolvedCalls",
      count: m.unresolvedCalls,
      points: Math.min(4, 2 * m.unresolvedCalls),
      evidence: calls
        .filter((e) => view.node.get(e.to)?.kind === "external-program")
        .map((e) => e.loc),
    },
    {
      factor: "fanIn",
      count: m.callers,
      points: Math.min(3, m.callers),
      evidence: (view.in.get(pid) ?? []).filter((e) => e.kind === "CALL").map((e) => e.loc),
    },
    {
      factor: "sharedOutputs",
      count: sharedOut.length,
      points: Math.min(3, sharedOut.length),
      evidence: sharedOut,
    },
    {
      factor: "sql",
      count: m.sql,
      points: m.sql > 0 ? 2 : 0,
      evidence: (view.out.get(pid) ?? []).filter((e) => e.kind === "SQL").map((e) => e.loc),
    },
    {
      factor: "cics",
      count: m.cics,
      points: m.cics > 0 ? 2 : 0,
      evidence: locs((x) => /^EXEC\s+CICS\b/.test(x.code)),
    },
  ];
  const missing = p.copies.filter((c) => !c.resolved);
  factors.push({
    factor: "missingCopybooks",
    count: missing.length,
    points: 2 * missing.length,
    evidence: missing.map((c) => ({ file: c.file, line: c.line })),
  });
  const used = factors.filter((f) => f.count > 0);
  const score = used.reduce((k, f) => k + f.points, 0);
  return { program: p.name, score, band: riskBand(score), factors: used };
}

/** Strongly connected components (Tarjan), each sorted, in a deterministic order. */
export function stronglyConnected(nodes: string[], edges: Map<string, string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    on.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (on.has(w)) {
        low.set(v, Math.min(low.get(v) as number, idx.get(w) as number));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop() as string;
        on.delete(w);
        comp.push(w);
      } while (w !== v);
      out.push(comp.toSorted());
    }
  };
  for (const v of nodes.toSorted()) {
    if (!idx.has(v)) {
      visit(v);
    }
  }
  return out.toSorted((a, b) => (a[0] < b[0] ? -1 : 1));
}

function couplingsOf(index: LegacyIndex, deps: Dependency[]): Coupling[] {
  const pairs = new Map<string, Coupling>();
  const get = (x: string, y: string) => {
    const [a, b] = x < y ? [x, y] : [y, x];
    const k = `${a}|${b}`;
    const c = pairs.get(k) ?? {
      a,
      b,
      calls: [],
      datasets: [],
      dataEvidence: [],
      copybooks: [],
      copyEvidence: [],
      weight: 0,
    };
    pairs.set(k, c);
    return c;
  };
  for (const d of deps) {
    const c = get(bare(d.from), bare(d.to));
    if (d.kind === "CALL") {
      c.calls.push(...d.evidence);
    } else {
      c.datasets.push(...d.via.map((v) => v.replace(/^dataset:/, "")));
      c.dataEvidence.push(...d.evidence);
    }
  }
  for (const book of index.copybooks) {
    const users = [...new Set(book.usedBy.map((u) => u.program))].toSorted();
    for (let i = 0; i < users.length; i++) {
      for (let j = i + 1; j < users.length; j++) {
        const c = get(users[i], users[j]);
        c.copybooks.push(book.name);
        c.copyEvidence.push(
          ...book.usedBy
            .filter((u) => u.program === users[i] || u.program === users[j])
            .map((u) => ({ file: u.file, line: u.line })),
        );
      }
    }
  }
  const list = [...pairs.values()];
  for (const c of list) {
    c.datasets = [...new Set(c.datasets)].toSorted();
    c.copybooks = [...new Set(c.copybooks)].toSorted();
    c.weight = 3 * c.calls.length + 2 * c.datasets.length + c.copybooks.length;
  }
  return list.toSorted(
    (x, y) => y.weight - x.weight || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1),
  );
}

export function wavePlan(index: LegacyIndex): WavePlan {
  const view = viewOf(buildGraph(index));
  const cov = coverage(index, view);
  const acc = accesses(view);
  const deps = programDependencies(view);
  const programs = index.programs.map((p) => p.name);
  // Outputs another program reads: written here, read (R/?) by a different program.
  const sharedOutputs = (p: string) =>
    acc.filter(
      (a) =>
        a.program === `program:${p}` &&
        producesOrConsumes(a.op).produces &&
        acc.some(
          (b) =>
            b.target === a.target && b.program !== a.program && producesOrConsumes(b.op).consumes,
        ),
    );
  const metrics = index.programs.map((p) =>
    metricsOf(
      p,
      view,
      new Set(acc.filter((a) => a.program === `program:${p.name}`).map((a) => a.target)),
    ),
  );
  const risks = index.programs.map((p, k) =>
    riskOf(p, metrics[k], view, [
      ...new Map(sharedOutputs(p.name).map((a) => [a.target, a.bind ?? a.loc])).values(),
    ]),
  );
  const riskOfName = new Map(risks.map((r) => [r.program, r]));
  const edges = new Map<string, string[]>();
  for (const d of deps) {
    edges.set(
      bare(d.from),
      [...new Set([...(edges.get(bare(d.from)) ?? []), bare(d.to)])].toSorted(),
    );
  }
  const sccs = stronglyConnected(programs, edges);
  const compOf = new Map<string, number>();
  sccs.forEach((c, k) => c.forEach((p) => compOf.set(p, k)));
  // Wave of a component: 1 + the latest wave of any component it depends on.
  const waveOfComp = new Map<number, number>();
  const waveFor = (k: number, guard: Set<number>): number => {
    const known = waveOfComp.get(k);
    if (known !== undefined) {
      return known;
    }
    guard.add(k);
    let w = 1;
    for (const p of sccs[k]) {
      for (const q of edges.get(p) ?? []) {
        const kq = compOf.get(q) as number;
        if (kq !== k && !guard.has(kq)) {
          w = Math.max(w, waveFor(kq, guard) + 1);
        }
      }
    }
    waveOfComp.set(k, w);
    return w;
  };
  sccs.forEach((_, k) => waveFor(k, new Set()));
  const waves: Wave[] = [];
  const waveOf: Record<string, number> = {};
  sccs.forEach((comp, k) => {
    const w = waveOfComp.get(k) as number;
    const score = Math.max(...comp.map((p) => riskOfName.get(p)?.score ?? 0));
    let wave = waves.find((x) => x.number === w);
    if (!wave) {
      wave = { number: w, groups: [] };
      waves.push(wave);
    }
    wave.groups.push({ programs: comp, cycle: comp.length > 1, score, band: riskBand(score) });
    for (const p of comp) {
      waveOf[p] = w;
    }
  });
  waves.sort((a, b) => a.number - b.number);
  for (const w of waves) {
    w.groups.sort((a, b) => a.score - b.score || (a.programs[0] < b.programs[0] ? -1 : 1));
  }
  // Clusters: connected components over CALL and data dependencies (undirected).
  const parent = new Map(programs.map((p) => [p, p]));
  const find = (x: string): string => {
    const px = parent.get(x) as string;
    return px === x ? x : find(px);
  };
  for (const d of deps) {
    const a = find(bare(d.from));
    const b = find(bare(d.to));
    if (a !== b) {
      parent.set(a < b ? b : a, a < b ? a : b);
    }
  }
  const clusterMap = new Map<string, string[]>();
  for (const p of programs.toSorted()) {
    const r = find(p);
    clusterMap.set(r, [...(clusterMap.get(r) ?? []), p]);
  }
  const outOfScope: WavePlan["outOfScope"] = [];
  for (const n of view.graph.nodes.filter(
    (x) => x.kind === "external-program" || x.kind === "dynamic-target",
  )) {
    outOfScope.push({
      name: n.kind === "dynamic-target" ? n.id.replace(/^dynamic:/, "") : n.name,
      kind: n.kind === "dynamic-target" ? "dynamic" : "external",
      evidence: (view.in.get(n.id) ?? []).map((e) => e.loc),
    });
  }
  return {
    schema: "kurahi.legacy-wave-plan/1",
    metrics,
    risks,
    dependencies: deps,
    cycles: sccs.filter((c) => c.length > 1),
    clusters: [...clusterMap.values()].toSorted(
      (a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1),
    ),
    couplings: couplingsOf(index, deps),
    waves,
    waveOf,
    outOfScope,
    coverage: cov,
  };
}
