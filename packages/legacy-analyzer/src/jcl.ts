// JCL: JOB, EXEC (PGM= or a procedure), DD (DSN, DISP, SYSOUT, DUMMY, in-stream data), SET,
// PROC/PEND (in-stream and cataloged procedures) and symbolic substitution (&NAME, &NAME.).
// Columns 1-71 are read; `//*` is a comment; an operand field ending in a comma continues on
// the next `//` line.

import type { DdStatement, Diagnostic, Job, JobStep } from "./types.js";

type RawStmt = { line: number; name: string; op: string; operands: string };

/** Split operands on top-level commas, honouring quotes and parentheses. */
export function splitOperands(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      quote = !quote;
    } else if (!quote && ch === "(") {
      depth++;
    } else if (!quote && ch === ")") {
      depth--;
    } else if (!quote && depth === 0 && ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) {
    out.push(cur);
  }
  return out.map((x) => x.trim()).filter(Boolean);
}

function keyword(operands: string[]): { positional: string[]; kw: Record<string, string> } {
  const positional: string[] = [];
  const kw: Record<string, string> = {};
  for (const o of operands) {
    const m = /^([A-Z0-9.@#$]+)=(.*)$/i.exec(o);
    if (m && !o.startsWith("'")) {
      kw[m[1].toUpperCase()] = m[2];
    } else {
      positional.push(o);
    }
  }
  return { positional, kw };
}

/** End of the operand field: the first blank outside quotes (comments follow it). */
function operandField(s: string): { text: string; continues: boolean } {
  let quote = false;
  let i = 0;
  for (; i < s.length; i++) {
    if (s[i] === "'") {
      quote = !quote;
    } else if (s[i] === " " && !quote) {
      break;
    }
  }
  const text = s.slice(0, i);
  return { text, continues: text.endsWith(",") };
}

function readStatements(content: string): { stmts: RawStmt[]; instream: Map<number, string[]> } {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const stmts: RawStmt[] = [];
  const instream = new Map<number, string[]>();
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i].slice(0, 71);
    const lineNo = i + 1;
    i++;
    if (!raw.startsWith("//") || raw.startsWith("//*")) {
      continue;
    }
    const m = /^\/\/(\S*)\s+(\S+)\s*(.*)$/.exec(raw);
    if (!m) {
      continue; // `//` null statement or malformed
    }
    const [, name, op, rest] = m;
    let { text, continues } = operandField(rest);
    while (continues && i < lines.length) {
      const next = lines[i].slice(0, 71);
      if (!next.startsWith("//") || next.startsWith("//*")) {
        if (next.startsWith("//*")) {
          i++;
          continue;
        }
        break;
      }
      i++;
      const more = operandField(next.slice(2).trimStart());
      text += more.text;
      continues = more.continues;
    }
    stmts.push({ line: lineNo, name, op: op.toUpperCase(), operands: text });
    const { positional, kw } = keyword(splitOperands(text));
    if (op.toUpperCase() === "DD" && (positional.includes("*") || positional.includes("DATA"))) {
      const dlm = kw.DLM?.replace(/'/g, "") ?? "/*";
      const data: string[] = [];
      while (
        i < lines.length &&
        !lines[i].startsWith(dlm) &&
        !(dlm === "/*" && lines[i].startsWith("//"))
      ) {
        data.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].startsWith(dlm)) {
        i++;
      }
      instream.set(lineNo, data);
    }
  }
  return { stmts, instream };
}

export function substitute(s: string, symbols: Record<string, string>): string {
  // `&&NAME` is a temporary data set name, not a symbol.
  return s.replace(/(^|[^&])&([A-Z@#$][A-Z0-9@#$]{0,7})\.?/gi, (m, pre: string, name: string) => {
    const v = symbols[name.toUpperCase()];
    return v === undefined ? m : pre + v;
  });
}

function stripQuotes(s: string | undefined): string | undefined {
  return s === undefined ? undefined : s.replace(/^'(.*)'$/, "$1");
}

function ddAccess(
  disp: string | undefined,
  sysout: boolean,
  instream: boolean,
  dummy: boolean,
): DdStatement["access"] {
  if (sysout) {
    return "sysout";
  }
  if (instream) {
    return "instream";
  }
  if (dummy) {
    return "unknown";
  }
  const status = (disp ?? "").replace(/^\(/, "").split(",")[0].toUpperCase();
  if (status === "SHR" || status === "") {
    return disp ? "input" : "unknown";
  }
  if (status === "OLD") {
    return "exclusive";
  }
  if (status === "NEW" || status === "MOD") {
    return "output";
  }
  return "unknown";
}

export function parseJcl(
  file: string,
  content: string,
): { jobs: Job[]; diagnostics: Diagnostic[] } {
  const { stmts, instream } = readStatements(content);
  const jobs: Job[] = [];
  const diagnostics: Diagnostic[] = [];
  let job: Job | undefined;
  let proc: Job | undefined;
  let step: JobStep | undefined;
  const target = () => proc ?? job;
  for (const s of stmts) {
    const { positional, kw } = keyword(splitOperands(s.operands));
    const owner = target();
    const symbols = owner?.symbols ?? {};
    switch (s.op) {
      case "JOB":
        job = { file, line: s.line, name: s.name, kind: "JOB", symbols: {}, steps: [] };
        proc = undefined;
        step = undefined;
        jobs.push(job);
        break;
      case "PROC": {
        proc = { file, line: s.line, name: s.name, kind: "PROC", symbols: {}, steps: [] };
        for (const [k, v] of Object.entries(kw)) {
          proc.symbols[k] = stripQuotes(v) ?? "";
        }
        step = undefined;
        jobs.push(proc);
        break;
      }
      case "PEND":
        proc = undefined;
        step = undefined;
        break;
      case "SET":
        for (const [k, v] of Object.entries(kw)) {
          symbols[k] = stripQuotes(v) ?? "";
        }
        break;
      case "EXEC": {
        if (!owner) {
          diagnostics.push({
            file,
            line: s.line,
            severity: "warning",
            message: "EXEC outside a JOB or PROC.",
          });
          break;
        }
        const pgm = kw.PGM ? stripQuotes(substitute(kw.PGM, symbols))?.toUpperCase() : undefined;
        const procName = pgm ? undefined : (kw.PROC ?? positional[0])?.toUpperCase();
        step = {
          file,
          line: s.line,
          name: s.name || `(step ${owner.steps.length + 1})`,
          program: pgm,
          proc: procName,
          parm: kw.PARM ? stripQuotes(substitute(kw.PARM, symbols)) : undefined,
          cond: kw.COND,
          dds: [],
        };
        owner.steps.push(step);
        break;
      }
      case "DD": {
        const ddname = (s.name || "(concatenated)").toUpperCase();
        const dsnRaw = kw.DSN ?? kw.DSNAME;
        const dsn = dsnRaw ? substitute(dsnRaw, symbols).toUpperCase() : undefined;
        const isInstream = positional.includes("*") || positional.includes("DATA");
        const dd: DdStatement = {
          file,
          line: s.line,
          ddname,
          dsn,
          dsnRaw: dsnRaw && dsnRaw !== dsn ? dsnRaw : undefined,
          disp: kw.DISP,
          sysout: kw.SYSOUT,
          instream: isInstream || undefined,
          dummy: positional.includes("DUMMY") || undefined,
          access: ddAccess(
            kw.DISP,
            kw.SYSOUT !== undefined,
            isInstream,
            positional.includes("DUMMY"),
          ),
        };
        if (instream.has(s.line)) {
          dd.instream = true;
        }
        if (step) {
          step.dds.push(dd);
        } else if (!/^(JOBLIB|JCLLIB|STEPLIB)$/.test(ddname)) {
          diagnostics.push({
            file,
            line: s.line,
            severity: "info",
            message: `DD ${ddname} outside a step.`,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return { jobs, diagnostics };
}

/** Attach the steps of known procedures to the EXEC statements that call them. */
export function expandProcs(jobs: Job[]): void {
  const procs = new Map(
    jobs.filter((j) => j.kind === "PROC").map((p) => [p.name.toUpperCase(), p]),
  );
  for (const j of jobs) {
    for (const st of j.steps) {
      const p = st.proc ? procs.get(st.proc) : undefined;
      if (p && p !== j) {
        st.procSteps = p.steps;
      }
    }
  }
}
