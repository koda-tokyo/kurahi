// プログラム仕様書 / Program specification: per program its basic facts, purpose (a placeholder,
// with the header comment quoted as written), inputs and outputs, CALL relations, the PERFORM
// structure and the business-rule candidates, each line citing the source.

import type { DocCtx } from "./design-doc-context.js";
import type { Program } from "./types.js";
import { programEndLine } from "./design-doc-context.js";
import { readIndexedFile } from "./indexer.js";
import { cell, cite, cites, code, table } from "./md.js";
import { rulesForProgram } from "./rules.js";
import { readCodeStream } from "./source.js";

/** The comment block right after PROGRAM-ID (before the next division), as written. */
export function headerComment(ctx: DocCtx, p: Program): Array<{ line: number; text: string }> {
  const text = readIndexedFile(ctx.index, p.file);
  if (text === null) {
    return [];
  }
  const stream = readCodeStream(p.file, text);
  const next =
    p.divisions.find((d) => d.name !== "IDENTIFICATION" && d.file === p.file)?.line ?? p.line + 60;
  const out: Array<{ line: number; text: string }> = [];
  let started = false;
  for (const c of stream.comments.filter((x) => x.line > p.line && x.line < next)) {
    const t = c.text.replace(/^[*=\s-]+|[*=\s-]+$/g, "");
    const separator = t.length === 0;
    if (separator && started) {
      break; // the first block only: change logs and rate tables follow separators
    }
    if (!separator) {
      started = true;
      out.push({ line: c.line, text: t });
    }
    if (out.length >= 12) {
      break;
    }
  }
  return out;
}

function basics(ctx: DocCtx, p: Program): string[] {
  const { s, view } = ctx;
  const stmts = p.paragraphs.reduce((k, x) => k + x.statements.length, 0);
  const proc = p.divisions.find((d) => d.name === "PROCEDURE");
  const steps = (view.in.get(`program:${p.name}`) ?? []).filter((e) => e.kind === "EXEC");
  const rows: string[][] = [
    [s.fProgramId, code(p.name), cite(p)],
    [
      s.fSource,
      `${cell(p.file)} (${s.linesRange(p.line, programEndLine(ctx.index, p.name))})`,
      cite(p),
    ],
    [s.fCounts, s.counts(p.paragraphs.length, stmts, p.dataItems.length), cite(proc ?? p)],
  ];
  if (p.usingParams.length > 0) {
    rows.push(["PROCEDURE DIVISION USING", code(p.usingParams.join(" ")), cite(proc ?? p)]);
  }
  for (const e of steps) {
    const st = view.node.get(e.from);
    rows.push([s.fRunBy, `${st?.attrs?.job}.${st?.name}`, cite(e.loc)]);
  }
  return table([s.colItem, s.colContent, s.colSource], rows);
}

function purpose(ctx: DocCtx, p: Program): string[] {
  const { s } = ctx;
  const out = [`- ${s.purposeLine} ${cite(p)}`];
  const header = headerComment(ctx, p);
  if (header.length > 0) {
    out.push("", `> ${s.headerCommentNote}`, ">");
    for (const h of header) {
      out.push(
        `> ${cite({ file: p.file, line: h.line })} ${h.text.replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"))}  `,
      );
    }
  }
  return out;
}

function io(ctx: DocCtx, p: Program): string[] {
  const { s, view } = ctx;
  const out: string[] = [];
  const rows: string[][] = [];
  for (const f of p.files) {
    const fid = `file:${p.name}.${f.name}`;
    const ops = (view.in.get(fid) ?? []).filter((e) => e.from === `program:${p.name}`);
    const modes = [
      ...new Set(ops.filter((e) => e.kind === "OPEN").map((e) => e.detail ?? "")),
    ].filter(Boolean);
    const verbs = [...new Set(ops.filter((e) => e.kind !== "OPEN").map((e) => e.kind))];
    const binds = (view.out.get(fid) ?? []).filter((e) => e.kind === "ASSIGN");
    const where = binds.map((b) => {
      const dd = view.node.get(b.to);
      const dsn = (view.out.get(b.to) ?? []).find((e) => e.kind === "DSN");
      return `${dd?.name} → ${dsn ? ctx.label(dsn.to) : dd?.attrs?.sysout !== undefined ? "SYSOUT" : "-"}`;
    });
    rows.push([
      code(f.name),
      code(f.assign),
      cell(f.organization),
      cell(modes.join(", ")),
      cell(verbs.join(", ")),
      cell(f.records.join(", ")),
      cell(where.join("; ")) || s.noneShort,
      cites([
        f,
        f.fdFile && f.fdLine ? { file: f.fdFile, line: f.fdLine } : undefined,
        ...ops.map((e) => e.loc),
        ...binds.map((b) => b.loc),
      ]),
    ]);
  }
  if (rows.length > 0) {
    out.push(
      ...table(
        [
          s.colFileDef,
          "ASSIGN",
          s.colOrganization,
          "OPEN",
          s.colOps,
          s.colRecords,
          s.colBoundDd,
          s.colSource,
        ],
        rows,
      ),
    );
  }
  const ext = (view.out.get(`program:${p.name}`) ?? []).filter(
    (e) => e.kind === "SQL" || e.kind === "CICS",
  );
  if (ext.length > 0) {
    if (out.length > 0) {
      out.push("");
    }
    out.push(
      ...table(
        [s.colTarget, s.colOps, s.colParagraph, s.colSource],
        ext.map((e) => [
          code(ctx.label(e.to)),
          `${e.kind} ${cell(e.detail)}`,
          code(e.paragraph),
          cite(e.loc),
        ]),
      ),
    );
  }
  return out.length > 0 ? out : [s.noIo];
}

function calls(ctx: DocCtx, p: Program): string[] {
  const { s, view } = ctx;
  const pid = `program:${p.name}`;
  const stmt = new Map(
    p.paragraphs
      .flatMap((x) => x.statements)
      .filter((x) => x.call)
      .map((x) => [`${x.file}:${x.line}`, x]),
  );
  // One row per partner, kind, USING list and paragraph; every call site is cited.
  const groups = new Map<string, { row: string[]; locs: Array<{ file: string; line: number }> }>();
  const add = (row: string[], l: { file: string; line: number }) => {
    const k = row.join("|");
    const g = groups.get(k) ?? { row, locs: [] };
    g.locs.push(l);
    groups.set(k, g);
  };
  for (const e of (view.out.get(pid) ?? []).filter((x) => x.kind === "CALL")) {
    const st = stmt.get(`${e.loc.file}:${e.loc.line}`);
    add(
      [
        s.callsOut,
        code(ctx.label(e.to)),
        cell(e.detail),
        code(st?.call?.using.join(" ")),
        code(e.paragraph),
      ],
      e.loc,
    );
  }
  for (const e of (view.in.get(pid) ?? []).filter((x) => x.kind === "CALL")) {
    add([s.callsIn, code(ctx.label(e.from)), cell(e.detail), "", code(e.paragraph)], e.loc);
  }
  const rows = [...groups.values()].map((g) => [...g.row, cites(g.locs, 12)]);
  return rows.length > 0
    ? table([s.colDirection, s.colPartner, s.colKind, "USING", s.colParagraph, s.colSource], rows)
    : [s.noCalls];
}

function performTree(ctx: DocCtx, p: Program): string[] {
  const { s, view } = ctx;
  if (p.paragraphs.length === 0) {
    return [s.noParagraphs];
  }
  const out: string[] = [];
  const expanded = new Set<string>();
  const kinds = new Set(["PERFORM", "PERFORM THRU", "GO TO"]);
  const walk = (id: string, depth: number, path: string[]) => {
    const seen = new Map<string, boolean>();
    for (const e of (view.out.get(id) ?? []).filter((x) => kinds.has(x.kind))) {
      const key = `${e.to}|${e.kind}`;
      if (seen.has(key)) {
        continue;
      }
      seen.set(key, true);
      const name = view.node.get(e.to)?.name ?? e.to.replace(/^paragraph:[^.]+\./, "");
      const pad = "  ".repeat(depth);
      const mark = path.includes(e.to)
        ? ` ${s.recursive}`
        : expanded.has(e.to)
          ? ` ${s.seenAbove}`
          : "";
      const thru = e.kind === "PERFORM THRU" ? ` (${e.detail})` : "";
      out.push(`${pad}- ${e.kind} \`${name}\`${thru}${mark} ${cite(e.loc)}`);
      if (!mark) {
        expanded.add(e.to);
        walk(e.to, depth + 1, [...path, e.to]);
      }
    }
  };
  const first = p.paragraphs[0];
  const firstId = `paragraph:${p.name}.${first.name}`;
  expanded.add(firstId);
  out.push(`- \`${first.name}\` (${s.entry}) ${cite(first)}`);
  walk(firstId, 1, [firstId]);
  const unref = ctx.cov.unreferencedParagraphs.filter((g) => g.subject.startsWith(`${p.name}.`));
  for (const g of unref) {
    out.push(`- \`${g.subject.slice(p.name.length + 1)}\` ${s.unreferenced} ${cite(g.loc)}`);
  }
  return out;
}

function ruleTable(ctx: DocCtx, p: Program): string[] {
  const { s } = ctx;
  const rules = rulesForProgram(p);
  if (rules.length === 0) {
    return [s.noRules];
  }
  const rows = rules.map((r) => [
    code(r.id),
    s.ruleKind(r.kind),
    code(r.paragraph),
    code(r.expression ?? r.source),
    r.guards.map((g) => code(g)).join("<br>"),
    cell(r.namedConstants.map((c) => `${c.name}=${c.value} (${c.file}:${c.line})`).join("; ")),
    s.tbc,
    [
      cite(r),
      cites(
        r.namedConstants.map((c) => ({ file: c.file, line: c.line })),
        3,
      ),
    ]
      .filter(Boolean)
      .join(" "),
  ]);
  return [
    ...table(
      [
        s.colId,
        s.colKind,
        s.colParagraph,
        s.colExpression,
        s.colGuards,
        s.colConstants,
        s.colMeaning,
        s.colSource,
      ],
      rows,
    ),
    "",
    `> ${s.rulesNote}`,
  ];
}

export function renderPrograms(ctx: DocCtx, n: number, only?: string): string[] {
  const { s, index } = ctx;
  const out = [`## ${n}. ${s.programSpecs}`, ""];
  const progs = index.programs.filter((p) => !only || p.name === only);
  if (progs.length === 0) {
    out.push(s.none);
    return out;
  }
  progs.forEach((p, k) => {
    const h = `${n}.${k + 1}`;
    out.push(
      `### ${h} ${p.name}`,
      "",
      `#### ${h}.1 ${s.basics}`,
      "",
      ...basics(ctx, p),
      "",
      `#### ${h}.2 ${s.purpose}`,
      "",
      ...purpose(ctx, p),
      "",
      `#### ${h}.3 ${s.io}`,
      "",
      ...io(ctx, p),
      "",
      `#### ${h}.4 ${s.callRelations}`,
      "",
      ...calls(ctx, p),
      "",
      `#### ${h}.5 ${s.performStructure}`,
      "",
      ...performTree(ctx, p),
      "",
      `#### ${h}.6 ${s.businessRules}`,
      "",
      ...ruleTable(ctx, p),
      "",
    );
  });
  return out;
}
