// Queries over a legacy index: call and perform graphs, file access, data references, job steps,
// dataset bindings. Every answer lists the facts behind it with file:line.

import type {
  DataItem,
  DdStatement,
  Job,
  JobStep,
  LegacyIndex,
  Paragraph,
  Program,
  Statement,
} from "./types.js";
import { ddNameOf } from "./data.js";

export type Ref = { file: string; line: number };

export type PerformEdge = Ref & {
  program: string;
  from: string;
  to: string;
  thru?: string;
  kind: "PERFORM" | "PERFORM THRU" | "GO TO";
  text: string;
};

export type CallEdge = Ref & {
  program: string;
  paragraph: string;
  target: string;
  dynamic: boolean;
  resolved: boolean;
  using: string[];
  text: string;
  hint?: string;
};

export type StepRef = Ref & { job: string; step: string; program: string; via?: string };

export type DdBinding = {
  job: string;
  step: string;
  program: string;
  ddname: string;
  dd: DdStatement;
  /** The SELECT that binds to this DD in the program, when one does. */
  fileName?: string;
  openModes: string[];
};

const up = (s: string) => s.trim().toUpperCase();

export function findProgram(index: LegacyIndex, name: string): Program | undefined {
  const n = up(name);
  return index.programs.find((p) => p.name === n);
}

/** All job steps (including steps of expanded procedures) with the program each runs. */
export function allSteps(index: LegacyIndex): Array<{ job: Job; step: JobStep; via?: string }> {
  const out: Array<{ job: Job; step: JobStep; via?: string }> = [];
  for (const job of index.jobs) {
    for (const step of job.steps) {
      out.push({ job, step });
      for (const ps of step.procSteps ?? []) {
        out.push({ job, step: ps, via: `${step.name} (PROC ${step.proc})` });
      }
    }
  }
  return out;
}

export function performEdges(index: LegacyIndex): PerformEdge[] {
  const edges: PerformEdge[] = [];
  for (const p of index.programs) {
    const order = p.paragraphs.map((x) => x.name);
    for (const para of p.paragraphs) {
      for (const st of para.statements) {
        if (st.performs && !st.performs.inline) {
          const { target, thru } = st.performs;
          const base = {
            program: p.name,
            from: para.name,
            file: st.file,
            line: st.line,
            text: st.text,
          };
          if (thru) {
            const a = order.indexOf(target);
            const b = order.indexOf(thru);
            const range = a >= 0 && b >= a ? order.slice(a, b + 1) : [target, thru];
            for (const to of range) {
              edges.push({ ...base, to, thru, kind: "PERFORM THRU" });
            }
          } else {
            edges.push({ ...base, to: target, kind: "PERFORM" });
          }
        }
        for (const g of st.goTo ?? []) {
          edges.push({
            program: p.name,
            from: para.name,
            to: g,
            kind: "GO TO",
            file: st.file,
            line: st.line,
            text: st.text,
          });
        }
      }
    }
  }
  return edges;
}

export function callEdges(index: LegacyIndex): CallEdge[] {
  const known = new Set(index.programs.map((p) => p.name));
  const edges: CallEdge[] = [];
  for (const p of index.programs) {
    const items = new Map(p.dataItems.map((d) => [d.name, d]));
    for (const para of p.paragraphs) {
      for (const st of para.statements) {
        if (!st.call) {
          continue;
        }
        const e: CallEdge = {
          program: p.name,
          paragraph: para.name,
          target: st.call.target,
          dynamic: st.call.dynamic,
          resolved: !st.call.dynamic && known.has(st.call.target),
          using: st.call.using,
          file: st.file,
          line: st.line,
          text: st.text,
        };
        if (st.call.dynamic) {
          const d = items.get(st.call.target);
          if (d?.value?.length === 1) {
            e.hint = `${d.name} has VALUE ${d.value[0]} at ${d.file}:${d.line}; the run-time value may differ`;
          }
        }
        edges.push(e);
      }
    }
  }
  return edges;
}

export function jobStepsFor(index: LegacyIndex, program: string): StepRef[] {
  const n = up(program);
  return allSteps(index)
    .filter(({ step }) => step.program === n)
    .map(({ job, step, via }) => ({
      job: job.name,
      step: step.name,
      program: n,
      file: step.file,
      line: step.line,
      via,
    }));
}

/** DD statements of the steps that run indexed programs, bound to the program's SELECTs. */
export function ddBindings(index: LegacyIndex): DdBinding[] {
  const out: DdBinding[] = [];
  for (const { job, step } of allSteps(index)) {
    if (!step.program) {
      continue;
    }
    const prog = findProgram(index, step.program);
    for (const dd of step.dds) {
      const sel = prog?.files.find((f) => ddNameOf(f.assign) === dd.ddname);
      const modes = new Set<string>();
      if (prog && sel) {
        for (const para of prog.paragraphs) {
          for (const st of para.statements) {
            if (st.io?.file === sel.name && st.io.op === "OPEN" && st.io.mode) {
              modes.add(st.io.mode);
            }
          }
        }
      }
      out.push({
        job: job.name,
        step: step.name,
        program: step.program,
        ddname: dd.ddname,
        dd,
        fileName: sel?.name,
        openModes: [...modes],
      });
    }
  }
  return out;
}

function statementsOf(p: Program): Array<{ para: Paragraph; st: Statement }> {
  return p.paragraphs.flatMap((para) => para.statements.map((st) => ({ para, st })));
}

function splitQualified(name: string): { program?: string; name: string } {
  const m = /^([A-Z0-9#@$-]+)[.:]([A-Z0-9#@$-]+)$/.exec(up(name));
  return m ? { program: m[1], name: m[2] } : { name: up(name) };
}

export function callers(index: LegacyIndex, nameIn: string) {
  const { program, name } = splitQualified(nameIn);
  const prog = findProgram(index, name);
  const calls = callEdges(index).filter((e) => e.target === name);
  const performs = performEdges(index).filter(
    (e) => e.to === name && (!program || e.program === program),
  );
  return {
    name,
    kind: prog ? "program" : performs.length > 0 ? "paragraph" : "unknown",
    calledBy: calls.map((e) => ({
      program: e.program,
      paragraph: e.paragraph,
      file: e.file,
      line: e.line,
      text: e.text,
    })),
    performedBy: performs.map((e) => ({
      program: e.program,
      paragraph: e.from,
      kind: e.kind,
      file: e.file,
      line: e.line,
      text: e.text,
    })),
    jobSteps: jobStepsFor(index, name),
  };
}

export function callees(index: LegacyIndex, nameIn: string) {
  const { program, name } = splitQualified(nameIn);
  const prog = !program ? findProgram(index, name) : undefined;
  if (prog) {
    const calls = callEdges(index).filter((e) => e.program === prog.name);
    return {
      name,
      kind: "program",
      calls: calls.map((e) => ({
        target: e.target,
        dynamic: e.dynamic,
        resolved: e.resolved,
        using: e.using,
        paragraph: e.paragraph,
        file: e.file,
        line: e.line,
        text: e.text,
        hint: e.hint,
      })),
      performs: performEdges(index)
        .filter((e) => e.program === prog.name)
        .map((e) => ({ from: e.from, to: e.to, kind: e.kind, file: e.file, line: e.line })),
    };
  }
  const performs = performEdges(index).filter(
    (e) => e.from === name && (!program || e.program === program),
  );
  const calls = callEdges(index).filter(
    (e) => e.paragraph === name && (!program || e.program === program),
  );
  return {
    name,
    kind: performs.length + calls.length > 0 ? "paragraph" : "unknown",
    performs: performs.map((e) => ({
      program: e.program,
      to: e.to,
      kind: e.kind,
      file: e.file,
      line: e.line,
      text: e.text,
    })),
    calls: calls.map((e) => ({
      program: e.program,
      target: e.target,
      dynamic: e.dynamic,
      resolved: e.resolved,
      file: e.file,
      line: e.line,
      text: e.text,
    })),
  };
}

export function fileAccess(index: LegacyIndex, fileIn: string, op?: string) {
  const f = up(fileIn);
  const bindings = ddBindings(index);
  const results: Array<
    Ref & {
      program: string;
      paragraph: string;
      op: string;
      mode?: string;
      file_: string;
      text: string;
    }
  > = [];
  const matched: Array<{ program: string; file: string; assign?: string; dataset?: string }> = [];
  for (const p of index.programs) {
    for (const fd of p.files) {
      const dsns = bindings
        .filter((b) => b.program === p.name && b.fileName === fd.name)
        .map((b) => b.dd.dsn ?? "");
      const hit = fd.name === f || ddNameOf(fd.assign) === f || fd.assign === f || dsns.includes(f);
      if (!hit) {
        continue;
      }
      matched.push({
        program: p.name,
        file: fd.name,
        assign: fd.assign,
        dataset: dsns.find(Boolean),
      });
      for (const { para, st } of statementsOf(p)) {
        if (
          st.io &&
          st.io.file === fd.name &&
          (!op || st.io.op === up(op) || (up(op) === "WRITE" && st.io.op === "REWRITE"))
        ) {
          results.push({
            program: p.name,
            paragraph: para.name,
            op: st.io.op,
            mode: st.io.mode,
            file_: fd.name,
            file: st.file,
            line: st.line,
            text: st.text,
          });
        }
      }
    }
  }
  return {
    file: f,
    matched,
    statements: results.map(({ file_, ...r }) => ({ ...r, fileName: file_ })),
    readers: [
      ...new Set(results.filter((r) => r.op === "READ").map((r) => `${r.program}.${r.paragraph}`)),
    ],
    writers: [
      ...new Set(
        results
          .filter((r) => r.op === "WRITE" || r.op === "REWRITE")
          .map((r) => `${r.program}.${r.paragraph}`),
      ),
    ],
  };
}

export function dataDefinitions(
  index: LegacyIndex,
  nameIn: string,
  program?: string,
): Array<DataItem & { program: string }> {
  const n = up(nameIn);
  return index.programs
    .filter((p) => !program || p.name === up(program))
    .flatMap((p) =>
      p.dataItems.filter((d) => d.name === n).map((d) => ({ ...d, program: p.name })),
    );
}

export function dataRefs(index: LegacyIndex, nameIn: string, program?: string) {
  const n = up(nameIn);
  const refs: Array<
    Ref & {
      program: string;
      paragraph: string;
      access: "set" | "use";
      verb: string;
      via?: string;
      text: string;
    }
  > = [];
  for (const p of index.programs) {
    if (program && p.name !== up(program)) {
      continue;
    }
    // Condition names of the item count as uses of it (IF EMP-MANAGER tests EMP-TYPE).
    const conds = p.dataItems.filter((d) => d.level === 88 && d.parent === n).map((d) => d.name);
    for (const { para, st } of statementsOf(p)) {
      const base = {
        program: p.name,
        paragraph: para.name,
        verb: st.verb,
        file: st.file,
        line: st.line,
        text: st.text,
      };
      if (st.sets.includes(n)) {
        refs.push({ ...base, access: "set" });
      }
      if (st.uses.includes(n)) {
        refs.push({ ...base, access: "use" });
      }
      for (const c of conds) {
        if (st.uses.includes(c) && !st.uses.includes(n)) {
          refs.push({ ...base, access: "use", via: c });
        }
      }
    }
  }
  return {
    item: n,
    definitions: dataDefinitions(index, n, program).map((d) => ({
      program: d.program,
      level: d.level,
      pic: d.pic,
      file: d.file,
      line: d.line,
      copybook: d.copybook,
    })),
    sets: refs.filter((r) => r.access === "set"),
    uses: refs.filter((r) => r.access === "use"),
  };
}

export function datasets(index: LegacyIndex, dsn?: string) {
  const all = ddBindings(index).filter((b) => b.dd.dsn && (!dsn || b.dd.dsn === up(dsn)));
  const byDsn = new Map<string, Array<Record<string, unknown>>>();
  for (const b of all) {
    const list = byDsn.get(b.dd.dsn as string) ?? [];
    list.push({
      job: b.job,
      step: b.step,
      program: b.program,
      ddname: b.ddname,
      disp: b.dd.disp,
      access: b.dd.access,
      fileName: b.fileName,
      openModes: b.openModes,
      file: b.dd.file,
      line: b.dd.line,
    });
    byDsn.set(b.dd.dsn as string, list);
  }
  return [...byDsn.entries()].map(([name, uses]) => ({ dsn: name, uses }));
}

export function summary(index: LegacyIndex) {
  const calls = callEdges(index);
  return {
    root: index.root,
    files: index.files.length,
    programs: index.programs.map((p) => ({
      name: p.name,
      file: p.file,
      line: p.line,
      divisions: p.divisions.map((d) => `${d.name}@${d.line}`),
      paragraphs: p.paragraphs.length,
      statements: p.paragraphs.reduce((n, x) => n + x.statements.length, 0),
      dataItems: p.dataItems.length,
      files: p.files.map((f) => f.name),
      copies: [...new Set(p.copies.map((c) => c.name))],
    })),
    copybooks: index.copybooks.map((c) => ({
      name: c.name,
      file: c.file,
      usedBy: [...new Set(c.usedBy.map((u) => u.program))],
    })),
    jobs: index.jobs.map((j) => ({
      name: j.name,
      kind: j.kind,
      file: j.file,
      steps: j.steps.map((s) => `${s.name}:${s.program ?? `PROC ${s.proc}`}`),
    })),
    counts: {
      programs: index.programs.length,
      paragraphs: index.programs.reduce((n, p) => n + p.paragraphs.length, 0),
      dataItems: index.programs.reduce((n, p) => n + p.dataItems.length, 0),
      files: index.programs.reduce((n, p) => n + p.files.length, 0),
      calls: calls.length,
      staticCalls: calls.filter((c) => !c.dynamic).length,
      dynamicCalls: calls.filter((c) => c.dynamic).length,
      performs: performEdges(index).length,
      jobSteps: allSteps(index).length,
    },
    diagnostics: index.diagnostics,
  };
}

export const QUERY_KINDS = [
  "summary",
  "programs",
  "paragraphs",
  "callers",
  "callees",
  "call-graph",
  "perform-graph",
  "file-access",
  "data-item",
  "data-refs",
  "job-steps",
  "datasets",
  "unresolved",
] as const;

export type QueryKind = (typeof QUERY_KINDS)[number];

export function runQuery(
  index: LegacyIndex,
  kind: string,
  args: Record<string, unknown> = {},
): unknown {
  const s = (k: string) => {
    const v = args[k];
    return typeof v === "string" ? v : "";
  };
  const need = (k: string) => {
    const v = s(k);
    if (!v) {
      throw new Error(`Query "${kind}" needs the argument "${k}".`);
    }
    return v;
  };
  switch (kind) {
    case "summary":
      return summary(index);
    case "programs":
      return summary(index).programs;
    case "paragraphs": {
      const p = findProgram(index, need("program"));
      if (!p) {
        throw new Error(`No program named ${s("program")} in the index.`);
      }
      return p.paragraphs.map((x) => ({
        name: x.name,
        section: x.section,
        file: x.file,
        line: x.line,
        endLine: x.endLine,
        statements: x.statements.length,
      }));
    }
    case "callers":
      return callers(index, need("name"));
    case "callees":
      return callees(index, need("name"));
    case "call-graph":
      return callEdges(index).map(({ text: _t, ...e }) => e);
    case "perform-graph": {
      const prog = s("program") ? up(s("program")) : undefined;
      return performEdges(index)
        .filter((e) => !prog || e.program === prog)
        .map(({ text: _t, ...e }) => e);
    }
    case "file-access":
      return fileAccess(index, need("file"), s("op") || undefined);
    case "data-item":
      return dataDefinitions(index, need("name"), s("program") || undefined);
    case "data-refs":
      return dataRefs(index, need("name"), s("program") || undefined);
    case "job-steps":
      return jobStepsFor(index, need("program"));
    case "datasets":
      return datasets(index, s("dsn") || undefined);
    case "unresolved":
      return {
        dynamicCalls: callEdges(index).filter((c) => c.dynamic),
        externalCalls: callEdges(index).filter((c) => !c.dynamic && !c.resolved),
        missingCopybooks: index.diagnostics.filter((d) => d.message.includes("copybook not found")),
        stepsWithoutSource: allSteps(index)
          .filter(({ step }) => step.program && !findProgram(index, step.program))
          .map(({ job, step }) => ({
            job: job.name,
            step: step.name,
            program: step.program,
            file: step.file,
            line: step.line,
          })),
      };
    default:
      throw new Error(`Unknown query kind "${kind}". Known kinds: ${QUERY_KINDS.join(", ")}.`);
  }
}
