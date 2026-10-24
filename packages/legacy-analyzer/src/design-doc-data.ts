// データ項目定義書 / Data dictionary (from copybooks) and the CRUD matrix (program × data set,
// table or CICS file), each with the source lines behind every entry.

import type { DocCtx } from "./design-doc-context.js";
import { dictionaryFor } from "./dictionary.js";
import { cell, cite, cites, code, table } from "./md.js";

const MAX_COLUMNS = 12;

export function renderDictionary(ctx: DocCtx, n: number): string[] {
  const { s, index } = ctx;
  const out = [`## ${n}. ${s.dictionary}`, ""];
  if (index.copybooks.length === 0) {
    out.push(s.noCopybooks);
    return out;
  }
  index.copybooks.forEach((c, k) => {
    out.push(`### ${n}.${k + 1} ${c.name} (${cite({ file: c.file, line: 1 })})`, "");
    let d: ReturnType<typeof dictionaryFor>;
    try {
      d = dictionaryFor(index, c.file);
    } catch (err) {
      out.push(`> ${s.cannotRead}: ${cell(err instanceof Error ? err.message : String(err))}`, "");
      return;
    }
    for (const u of c.usedBy) {
      out.push(`- ${s.usedBy}: \`${u.program}\` ${cite(u)}`);
    }
    if (c.usedBy.length === 0) {
      out.push(`- ${s.usedByNone} ${cite({ file: c.file, line: 1 })}`);
    }
    for (const r of d.records) {
      const e = d.entries.find((x) => x.name === r.name && (x.level === 1 || x.level === 77));
      out.push(`- ${s.recordLength(r.name, r.length)} ${cite(e)}`);
    }
    out.push("");
    const rows = d.entries.map((e) => {
      const depth = e.path.split(".").length - 1;
      const pos = e.start !== undefined && e.end !== undefined ? `${e.start}-${e.end}` : "";
      const values = e.level === 88 ? (e.conditionValues ?? []).join(" ") : (e.value ?? "");
      return [
        String(e.level).padStart(2, "0"),
        `${"&nbsp;&nbsp;".repeat(depth)}${code(e.name)}`,
        code(e.pic),
        cell(e.usage),
        e.length === undefined
          ? e.level === 88
            ? ""
            : s.unknown
          : String(e.totalLength ?? e.length),
        pos,
        e.occurs === undefined ? "" : String(e.occurs),
        code(e.redefines),
        code(values),
        cell(e.description),
        cite(e),
      ];
    });
    out.push(
      ...table(
        [
          s.colLevel,
          s.colName,
          "PIC",
          "USAGE",
          s.colBytes,
          s.colPosition,
          "OCCURS",
          "REDEFINES",
          s.colValues,
          s.colDescription,
          s.colSource,
        ],
        rows,
      ),
      "",
    );
  });
  out.push(`> ${s.dictionaryNote}`);
  return out;
}

export function renderCrud(ctx: DocCtx, n: number): string[] {
  const { s, crud } = ctx;
  const out = [`## ${n}. ${s.crud}`, ""];
  if (crud.evidence.length === 0) {
    out.push(s.noCrud);
    return out;
  }
  out.push(`> ${s.crudLegend}`, "");
  for (let start = 0; start < crud.targets.length; start += MAX_COLUMNS) {
    const cols = crud.targets.slice(start, start + MAX_COLUMNS);
    const rows = crud.programs
      .filter((p) => cols.some((t) => crud.cells.get(p)?.has(t)))
      .map((p) => {
        const row = crud.cells.get(p);
        const ev = crud.evidence.filter((a) => a.program === p && cols.includes(a.target));
        return [
          code(ctx.label(p)),
          ...cols.map((t) => (row?.get(t) ?? []).join("")),
          cites(
            ev.map((a) => a.loc),
            8,
          ),
        ];
      });
    out.push(
      ...table([s.colProgram, ...cols.map((t) => code(ctx.label(t))), s.colSource], rows),
      "",
    );
  }
  out.push(`### ${n}.1 ${s.crudEvidence}`, "");
  const rows = crud.evidence.map((a) => [
    code(ctx.label(a.program)),
    code(ctx.label(a.target)),
    a.op,
    cell(a.via),
    code(a.paragraph),
    a.step ? cell(a.step.replace(/^step:/, "")) : "",
    cites([a.loc, a.bind]),
  ]);
  out.push(
    ...table(
      [s.colProgram, s.colTarget, s.colOp, s.colVia, s.colParagraph, s.colStep, s.colSource],
      rows,
    ),
  );
  return out;
}
