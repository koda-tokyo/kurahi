// Coverage report data: what was parsed, what was not and why, and every gap the analyser can
// see (unresolved and dynamic calls, missing copybooks, steps without source, EXEC blocks that
// are not modelled, unbound files and DDs, paragraphs nothing refers to). Nothing is inferred to
// close a gap; each entry carries the file:line where the gap is.

import fs from "node:fs";
import path from "node:path";
import type { GraphView } from "./crud.js";
import type { Diagnostic, LegacyIndex, Loc, SourceFile } from "./types.js";
import { parseCics } from "./graph.js";
import { SKIPPED_DIRS, readIndexedFile } from "./indexer.js";
import { readCodeStream } from "./source.js";

export type Gap = { loc: Loc; subject: string; detail: string };

export type Coverage = {
  parsed: Array<SourceFile & { programs: string[]; jobs: string[] }>;
  notAnalysed: string[];
  notAnalysedTotal: number;
  skipped: Diagnostic[];
  diagnostics: Diagnostic[];
  externalCalls: Gap[];
  dynamicCalls: Gap[];
  missingCopybooks: Gap[];
  stepsWithoutSource: Gap[];
  execNotModelled: Gap[];
  unboundFiles: Gap[];
  unboundDds: Gap[];
  noEntry: Gap[];
  unreferencedParagraphs: Gap[];
  unknownLengths: Gap[];
};

const MAX_LISTED = 50;

/** DD names that name libraries or dumps, not data the program reads or writes. */
const SYSTEM_DDS = new Set(["STEPLIB", "JOBLIB", "SYSUDUMP", "SYSABEND", "SYSMDUMP", "CEEDUMP"]);

function otherFiles(
  index: LegacyIndex,
  alsoAnalysed: ReadonlySet<string> = new Set(),
): { listed: string[]; total: number } {
  let isFile: boolean;
  try {
    isFile = fs.statSync(index.root).isFile();
  } catch {
    return { listed: [], total: 0 };
  }
  if (isFile) {
    return { listed: [], total: 0 };
  }
  const base = index.root;
  const indexed = new Set(index.files.map((f) => f.path));
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !SKIPPED_DIRS.has(e.name)) {
        visit(full);
      } else if (e.isFile()) {
        const rel = path.relative(base, full).split(path.sep).join("/");
        if (!indexed.has(rel) && !alsoAnalysed.has(rel)) {
          out.push(rel);
        }
      }
    }
  };
  visit(base);
  return { listed: out.slice(0, MAX_LISTED), total: out.length };
}

/** EXEC SQL/CICS/DLI lines in COBOL sources and copybooks that no parsed statement covers. */
function unparsedExec(index: LegacyIndex): Gap[] {
  const covered = new Map<string, Array<[number, number]>>();
  for (const p of index.programs) {
    for (const para of p.paragraphs) {
      for (const st of para.statements.filter((x) => x.verb === "EXEC")) {
        covered.set(st.file, [...(covered.get(st.file) ?? []), [st.line, st.endLine]]);
      }
    }
  }
  const gaps: Gap[] = [];
  for (const f of index.files.filter((x) => x.kind !== "jcl")) {
    const text = readIndexedFile(index, f.path);
    if (text === null) {
      continue;
    }
    const stream = readCodeStream(f.path, text);
    const comment = new Set(stream.comments.map((c) => c.line));
    stream.physical.forEach((raw, i) => {
      const line = i + 1;
      const area = stream.format === "fixed" ? raw.slice(7, 72) : raw;
      const m = /\bEXEC\s+(SQL|CICS|DLI)\b(.*)$/i.exec(area);
      if (!m || comment.has(line)) {
        return;
      }
      const inStmt = (covered.get(f.path) ?? []).some(([a, z]) => line >= a && line <= z);
      if (!inStmt) {
        gaps.push({
          loc: { file: f.path, line },
          subject: `EXEC ${m[1].toUpperCase()}`,
          detail: area.trim().slice(0, 80),
        });
      }
    });
  }
  return gaps;
}

/** `alsoAnalysed`: files other engines read (Java, SQL DDL), not listed as "not analysed". */
export function coverage(
  index: LegacyIndex,
  view: GraphView,
  alsoAnalysed?: ReadonlySet<string>,
): Coverage {
  const other = otherFiles(index, alsoAnalysed);
  const node = view.node;
  const cov: Coverage = {
    parsed: index.files.map((f) => ({
      ...f,
      programs: index.programs.filter((p) => p.file === f.path).map((p) => p.name),
      jobs: index.jobs.filter((j) => j.file === f.path).map((j) => j.name),
    })),
    notAnalysed: other.listed,
    notAnalysedTotal: other.total,
    skipped: index.diagnostics.filter(
      (d) => d.message.startsWith("Skipped:") || d.message.startsWith("File limit"),
    ),
    diagnostics: index.diagnostics.filter(
      (d) => !d.message.startsWith("Skipped:") && !d.message.startsWith("File limit"),
    ),
    externalCalls: [],
    dynamicCalls: [],
    missingCopybooks: [],
    stepsWithoutSource: [],
    execNotModelled: unparsedExec(index),
    unboundFiles: [],
    unboundDds: [],
    noEntry: [],
    unreferencedParagraphs: [],
    unknownLengths: [],
  };
  for (const e of view.graph.edges) {
    const to = node.get(e.to);
    const from = node.get(e.from);
    if (e.kind === "CALL" && to?.kind === "external-program") {
      cov.externalCalls.push({
        loc: e.loc,
        subject: `${from?.name} → ${to.name}`,
        detail: e.detail ?? "",
      });
    } else if (e.kind === "CALL" && to?.kind === "dynamic-target") {
      const prog = index.programs.find((p) => p.name === from?.name);
      const d = prog?.dataItems.find((x) => x.name === to.name);
      const hint = d?.value?.length === 1 ? `VALUE ${d.value[0]} (${d.file}:${d.line})` : "";
      cov.dynamicCalls.push({ loc: e.loc, subject: `${from?.name} → ${to.name}`, detail: hint });
    } else if (e.kind === "COPY" && e.detail === "not found") {
      cov.missingCopybooks.push({
        loc: e.loc,
        subject: to?.name ?? e.to,
        detail: from?.name ?? "",
      });
    } else if (e.kind === "EXEC" && to?.kind === "external-program") {
      cov.stepsWithoutSource.push({
        loc: e.loc,
        subject: `${from?.attrs?.job}.${from?.name}`,
        detail: to.name,
      });
    }
  }
  for (const p of index.programs) {
    for (const para of p.paragraphs) {
      for (const st of para.statements.filter((x) => x.verb === "EXEC")) {
        const cics = parseCics(st.code);
        if (cics) {
          const modelled =
            cics.file !== undefined ||
            ((cics.command === "LINK" || cics.command === "XCTL") && cics.program);
          if (!modelled) {
            const why = cics.fileDynamic
              ? `FILE(${cics.fileDynamic})`
              : cics.programDynamic
                ? `PROGRAM(${cics.programDynamic})`
                : "";
            cov.execNotModelled.push({
              loc: st,
              subject: `EXEC CICS ${cics.command}`,
              detail: why,
            });
          }
        } else if (/^EXEC\s+SQL\s+INCLUDE\b/i.test(st.code) || /^EXEC\s+DLI\b/i.test(st.code)) {
          cov.execNotModelled.push({
            loc: st,
            subject: st.code.split(/\s+/).slice(0, 3).join(" "),
            detail: st.code.slice(0, 80),
          });
        } else if (
          st.sql &&
          st.sql.tables.length === 0 &&
          !/^(COMMIT|ROLLBACK|WHENEVER|CLOSE|CONNECT)$/.test(st.sql.ops[0] ?? "")
        ) {
          cov.execNotModelled.push({
            loc: st,
            subject: `EXEC SQL ${st.sql.ops[0] ?? ""}`.trim(),
            detail: st.code.slice(0, 80),
          });
        }
      }
    }
    // Paragraphs nothing PERFORMs or GOes TO (the first one is the entry point).
    const targeted = new Set(
      view.graph.edges
        .filter((e) => e.from.startsWith(`paragraph:${p.name}.`) && e.to.startsWith("paragraph:"))
        .map((e) => e.to),
    );
    p.paragraphs.slice(1).forEach((para) => {
      if (para.name !== "(PROCEDURE)" && !targeted.has(`paragraph:${p.name}.${para.name}`)) {
        cov.unreferencedParagraphs.push({
          loc: para,
          subject: `${p.name}.${para.name}`,
          detail: para.section ?? "",
        });
      }
    });
    const pid = `program:${p.name}`;
    const steps = (view.in.get(pid) ?? []).filter((e) => e.kind === "EXEC");
    const callers = (view.in.get(pid) ?? []).filter((e) => e.kind === "CALL");
    if (steps.length === 0 && callers.length === 0) {
      cov.noEntry.push({ loc: p, subject: p.name, detail: "" });
    }
    for (const f of p.files) {
      const bound = (view.out.get(`file:${p.name}.${f.name}`) ?? []).some(
        (e) => e.kind === "ASSIGN",
      );
      if (steps.length > 0 && !bound) {
        cov.unboundFiles.push({ loc: f, subject: `${p.name}.${f.name}`, detail: f.assign ?? "" });
      }
    }
    for (const step of steps) {
      for (const dd of (view.out.get(step.from) ?? []).filter((e) => e.kind === "DD")) {
        const hasDsn = (view.out.get(dd.to) ?? []).some((e) => e.kind === "DSN");
        const bound = (view.in.get(dd.to) ?? []).some((e) => e.kind === "ASSIGN");
        const ddNode = node.get(dd.to);
        if (hasDsn && !bound && !SYSTEM_DDS.has(ddNode?.name ?? "")) {
          const dsn = (view.out.get(dd.to) ?? []).find((e) => e.kind === "DSN");
          cov.unboundDds.push({
            loc: dd.loc,
            subject: `${p.name} DD ${ddNode?.name}`,
            detail: node.get(dsn?.to ?? "")?.name ?? "",
          });
        }
      }
    }
  }
  for (const p of index.programs) {
    for (const d of p.dataItems) {
      if (
        d.copybook &&
        d.length === undefined &&
        d.level !== 88 &&
        d.level !== 66 &&
        d.name !== "FILLER"
      ) {
        cov.unknownLengths.push({
          loc: d,
          subject: `${d.copybook}.${d.name}`,
          detail: d.pic ?? "",
        });
      }
    }
  }
  const dedup = (gs: Gap[]) => {
    const seen = new Set<string>();
    return gs.filter((g) => {
      const k = `${g.loc.file}:${g.loc.line}:${g.subject}`;
      if (seen.has(k)) {
        return false;
      }
      seen.add(k);
      return true;
    });
  };
  cov.unknownLengths = dedup(cov.unknownLengths);
  cov.unboundDds = dedup(cov.unboundDds);
  return cov;
}

/** The number of open questions a human must answer (every gap list, diagnostics excluded). */
export function gapCount(c: Coverage): number {
  return (
    c.externalCalls.length +
    c.dynamicCalls.length +
    c.missingCopybooks.length +
    c.stepsWithoutSource.length +
    c.execNotModelled.length +
    c.unboundFiles.length +
    c.unboundDds.length +
    c.noEntry.length +
    c.unreferencedParagraphs.length +
    c.unknownLengths.length
  );
}
