// ジョブフロー / JCL job flow: per job a Mermaid diagram of steps and data sets, the steps with
// PARM and COND, the DD statements with their binding to the program's SELECT, and the lineage
// of each data set (who writes it, who reads it).

import type { DocCtx } from "./design-doc-context.js";
import type { GraphEdge } from "./graph.js";
import { producesOrConsumes } from "./crud.js";
import { readIndexedFile } from "./indexer.js";
import { cell, cite, cites, code, mermaidIds, mermaidLabel, table } from "./md.js";

/** DD edges of a step in source order. */
export function ddsOf(ctx: DocCtx, stepId: string): GraphEdge[] {
  return (ctx.view.out.get(stepId) ?? [])
    .filter((e) => e.kind === "DD")
    .toSorted((a, b) => a.loc.line - b.loc.line);
}

/** Direction of a DD for the diagram: the program's own I/O when the DD is bound, else DISP. */
function ddDirection(
  ctx: DocCtx,
  dd: GraphEdge,
): { reads: boolean; writes: boolean; unsure: boolean } {
  const { view } = ctx;
  const bound = (view.in.get(dd.to) ?? []).find((e) => e.kind === "ASSIGN");
  if (bound) {
    const ops = new Set<string>((view.in.get(bound.from) ?? []).map((e) => e.kind));
    const reads = ops.has("READ") || ops.has("START");
    const writes = ops.has("WRITE") || ops.has("REWRITE") || ops.has("DELETE");
    if (reads || writes) {
      return { reads, writes, unsure: false };
    }
  }
  return {
    reads: dd.detail === "input" || dd.detail === "instream" || dd.detail === "exclusive",
    writes: dd.detail === "output",
    unsure: dd.detail === "exclusive",
  };
}

function jobDiagram(ctx: DocCtx, steps: GraphEdge[]): string[] {
  const { view } = ctx;
  const id = mermaidIds();
  const out = ["```mermaid", "flowchart TD"];
  const datasets = new Set<string>();
  const links: string[] = [];
  let prev: string | undefined;
  for (const st of steps) {
    const step = view.node.get(st.to);
    if (!step) {
      continue;
    }
    const sid = id(st.to);
    const what = step.attrs?.program ?? (step.attrs?.proc ? `PROC ${step.attrs.proc}` : "");
    out.push(`  ${sid}[${mermaidLabel(`${step.name}: ${what}`)}]`);
    if (prev) {
      links.push(`  ${prev} ==> ${sid}`);
    }
    prev = sid;
    for (const dd of ddsOf(ctx, st.to)) {
      const dsn = (view.out.get(dd.to) ?? []).find((e) => e.kind === "DSN");
      if (!dsn) {
        continue;
      }
      const did = id(dsn.to);
      if (!datasets.has(dsn.to)) {
        datasets.add(dsn.to);
        out.push(`  ${did}[(${mermaidLabel(ctx.label(dsn.to))})]`);
      }
      const ddName = view.node.get(dd.to)?.name ?? "";
      const dir = ddDirection(ctx, dd);
      if (dir.unsure) {
        links.push(`  ${did} -.->|${ddName} OLD| ${sid}`);
        continue;
      }
      if (dir.reads) {
        links.push(`  ${did} -->|${ddName}| ${sid}`);
      }
      if (dir.writes) {
        links.push(`  ${sid} -->|${ddName}| ${did}`);
      }
    }
  }
  out.push(...links, "```");
  return out;
}

export function renderJobFlow(ctx: DocCtx, n: number): string[] {
  const { index, s, view } = ctx;
  const out = [`## ${n}. ${s.jobFlow}`, ""];
  if (index.jobs.length === 0) {
    out.push(s.noJobs);
    return out;
  }
  let k = 0;
  for (const job of index.jobs) {
    k++;
    const jid = `job:${job.name}`;
    const steps = (view.out.get(jid) ?? [])
      .filter((e) => e.kind === "STEP")
      .toSorted((a, b) => a.loc.line - b.loc.line);
    out.push(
      `### ${n}.${k} ${job.kind === "JOB" ? s.kindJob : s.kindProc} ${job.name} (${cite(job)})`,
      "",
    );
    if (Object.keys(job.symbols).length > 0) {
      const text = (readIndexedFile(index, job.file) ?? "").split("\n");
      const where = (sym: string) => {
        const re = new RegExp(`^//\\S*\\s+(SET|PROC)\\s.*\\b${sym.replace(/[$]/g, "\\$")}=`);
        const i = text.findIndex((l, j) => j + 1 >= job.line && re.test(l.slice(0, 71)));
        return i >= 0 ? { file: job.file, line: i + 1 } : job;
      };
      const symRows = Object.entries(job.symbols)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([a, v]) => [code(a), code(v), cite(where(a))]);
      out.push(...table([s.colSymbol, s.colValue, s.colSource], symRows), "");
    }
    out.push(...jobDiagram(ctx, steps), "");
    const stepRows = steps.map((e, i) => {
      const st = view.node.get(e.to);
      const runs = st?.attrs?.program ?? (st?.attrs?.proc ? `PROC ${st.attrs.proc}` : "");
      const hasSource = st?.attrs?.program
        ? view.node.get(`program:${st.attrs.program}`)?.kind === "program"
        : false;
      return [
        String(i + 1),
        cell(st?.name),
        cell(runs) + (st?.attrs?.program && !hasSource ? ` (${s.noSource})` : ""),
        code(st?.attrs?.parm),
        code(st?.attrs?.cond),
        cite(e.loc),
      ];
    });
    out.push(...table(["#", s.colStep, s.colProgram, "PARM", "COND", s.colSource], stepRows), "");
    const ddRows: string[][] = [];
    for (const e of steps) {
      for (const dd of ddsOf(ctx, e.to)) {
        const ddNode = view.node.get(dd.to);
        const dsn = (view.out.get(dd.to) ?? []).find((x) => x.kind === "DSN");
        const bound = (view.in.get(dd.to) ?? []).find((x) => x.kind === "ASSIGN");
        const fileNode = bound ? view.node.get(bound.from) : undefined;
        const ds = dsn
          ? ctx.label(dsn.to)
          : ddNode?.attrs?.sysout !== undefined
            ? `SYSOUT=${ddNode.attrs.sysout}`
            : "";
        ddRows.push([
          cell(view.node.get(e.to)?.name),
          cell(ddNode?.name),
          code(ds),
          code(ddNode?.attrs?.disp),
          s.access(ddNode?.attrs?.access ?? "unknown"),
          fileNode ? `${fileNode.attrs?.program}.${fileNode.name}` : "",
          cite(dd.loc),
        ]);
      }
    }
    if (ddRows.length > 0) {
      out.push(
        ...table(
          [s.colStep, "DD", s.colDataset, "DISP", s.colAccess, s.colBoundFile, s.colSource],
          ddRows,
        ),
        "",
      );
    }
  }
  // Lineage: every data set with its producers and consumers.
  out.push(`### ${n}.${k + 1} ${s.lineage}`, "");
  const datasets = ctx.graph.nodes.filter(
    (x) => x.kind === "dataset" || x.kind === "table" || x.kind === "cics-file",
  );
  const rows: string[][] = [];
  for (const d of datasets) {
    const acc = ctx.crud.evidence.filter((a) => a.target === d.id);
    const fmt = (list: typeof acc) => {
      const by = new Map<string, typeof acc>();
      for (const a of list) {
        by.set(a.program, [...(by.get(a.program) ?? []), a]);
      }
      return [...by.entries()]
        .map(([p, as]) => `${ctx.label(p)} (${[...new Set(as.map((a) => a.op))].join("")})`)
        .join(", ");
    };
    const prod = acc.filter((a) => producesOrConsumes(a.op).produces || a.op === "D");
    const cons = acc.filter((a) => producesOrConsumes(a.op).consumes);
    const refs = cites([
      d.loc,
      ...(view.in.get(d.id) ?? []).map((e) => e.loc),
      ...acc.map((a) => a.loc),
    ]);
    rows.push([
      code(ctx.label(d.id)),
      cell(fmt(prod)) || s.noneShort,
      cell(fmt(cons)) || s.noneShort,
      refs,
    ]);
  }
  if (rows.length > 0) {
    out.push(
      ...table([s.colDataset, s.colProducers, s.colConsumers, s.colSource], rows),
      "",
      `> ${s.lineageNote}`,
    );
  } else {
    out.push(s.none);
  }
  return out;
}
