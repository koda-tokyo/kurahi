// PL/I 手続き仕様 / PL/I procedure specifications of the design document: the procedure list,
// structure definitions (levels, attributes, storage), file definitions with their DD names and
// operations, then per procedure its purpose (the comment above, or an explicit placeholder),
// declaration, calls, EXEC SQL, file I/O and ON-units, and what the engine did not model. Every
// fact line cites `path:line`.

import type { DocCtx } from "../design-doc-context.js";
import type { PliAnalysis } from "./pli-resolve.js";
import type { PliProc } from "./pli-types.js";
import { cell, cite, cites, code, table } from "../md.js";
import { sciStrings } from "./doc-i18n-sci.js";
import { opsOfSql } from "./java-resolve.js";

const crudOf = (ops: string[]) => ["C", "R", "U", "D", "?"].filter((o) => ops.includes(o)).join("");

function tablesOf(p: PliAnalysis, qn: string): string {
  const by = new Map<string, string[]>();
  for (const t of p.tableUses.filter((x) => x.proc === qn)) {
    by.set(t.table, [...(by.get(t.table) ?? []), ...opsOfSql(t.op)]);
  }
  return [...by].map(([t, ops]) => `${t} ${crudOf(ops)}`).join(", ");
}

export function renderPli(ctx: DocCtx, n: number): string[] {
  const m = sciStrings(ctx.lang);
  const out = [`## ${n}. ${m.pli}`, ""];
  const p = ctx.poly?.pli;
  if (!p || p.procs.length === 0) {
    out.push(m.noPli);
    return out;
  }
  out.push(`> ${m.pliNote}`, "", `### ${n}.1 ${m.procList}`, "");
  out.push(
    ...table(
      [m.colProc, m.colKind, m.colParent, m.colCalls, m.colTables, m.colFiles, m.colSource],
      p.procs.map((x) => [
        code(x.qualified),
        x.main ? m.main : x.parent ? m.internal : m.external,
        code(x.parent),
        cell(
          [...new Set(p.calls.filter((c) => c.from === x.qualified).map((c) => c.to))].join(", "),
        ),
        cell(tablesOf(p, x.qualified)),
        cell(
          [
            ...new Set(p.fileUses.filter((u) => u.proc === x.qualified).map((u) => u.fileName)),
          ].join(", "),
        ),
        cite(x),
      ]),
    ),
    "",
  );
  out.push(`### ${n}.2 ${m.structures}`, "");
  if (p.structures.length === 0) {
    out.push(ctx.s.none, "");
  }
  for (const s of p.structures) {
    out.push(`- ${code(s.root.name)} (${code(s.proc)}) ${cite(s.root)}`, "");
    out.push(
      ...table(
        [m.colLevel, m.colName, m.colAttrs, m.colStorage, m.colInit, m.colSource],
        [s.root, ...s.members].map((d) => [
          String(d.level),
          code(
            `${"  ".repeat(Math.max(0, d.path.length - 1))}${d.name}${d.dims ? `(${d.dims})` : ""}`,
          ),
          code(d.type),
          code(d.storage.join(" ")),
          code(d.init),
          cite(d),
        ]),
      ),
      "",
    );
  }
  out.push(`### ${n}.3 ${m.files}`, "");
  const files = new Map<string, PliAnalysis["fileUses"]>();
  for (const u of p.fileUses) {
    const k = `${u.program}.${u.fileName}`;
    files.set(k, [...(files.get(k) ?? []), u]);
  }
  if (files.size === 0) {
    out.push(ctx.s.none, "");
  } else {
    out.push(
      ...table(
        [m.colName, m.colAttrs, m.colDd, m.colOps, m.colSource],
        [...files].map(([k, us]) => [
          code(k),
          us[0].declared ? code(us[0].declared.attrs.join(" ")) : m.undeclared,
          code(us[0].dd),
          cell([...new Set(us.map((u) => u.verb))].join(", ")),
          cites([us[0].declared, ...us]),
        ]),
      ),
      "",
    );
  }
  p.procs.forEach((x, k) => out.push(...procSpec(ctx, p, x, `${n}.${k + 4}`)));
  // Calls that reach no program of the project (a COBOL or FORTRAN program of that name is in it).
  const external = p.calls.filter(
    (c) =>
      c.resolution !== "internal" &&
      c.resolution !== "external procedure" &&
      ctx.view.node.get(`program:${c.to}`)?.kind !== "program",
  );
  const missing = p.includes.filter((i) => !i.resolved);
  if (p.gaps.length + missing.length + external.length > 0) {
    out.push(`### ${n}.${p.procs.length + 4} ${m.notModelled}`, "");
    for (const g of p.gaps) {
      out.push(`- ${code(g.construct)}: ${cell(g.detail)} ${cite(g)}`);
    }
    for (const c of external) {
      out.push(
        `- ${m.externalCalls}: ${code(c.from)} → ${code(c.to)} ${cell(c.resolution)} ${cite(c)}`,
      );
    }
    for (const i of missing) {
      out.push(`- %INCLUDE ${code(i.name)}: ${m.notFound} ${cite(i)}`);
    }
    out.push("");
  }
  return out;
}

function procSpec(ctx: DocCtx, p: PliAnalysis, x: PliProc, num: string): string[] {
  const m = sciStrings(ctx.lang);
  const out = [`### ${num} ${x.qualified}`, ""];
  out.push(
    x.doc
      ? `- ${m.purpose}: ${cell(x.doc)} ${m.fromComment} ${cite(x)}`
      : `- ${m.purpose}: ${m.tbc} ${cite(x)}`,
  );
  const decl = [
    `${x.name}: PROCEDURE${x.params.length ? `(${x.params.join(", ")})` : ""}`,
    x.options ? `OPTIONS(${x.options})` : "",
    x.returns ? `RETURNS(${x.returns})` : "",
    x.recursive ? "RECURSIVE" : "",
  ]
    .filter(Boolean)
    .join(" ");
  out.push(`- ${m.declaration}: ${code(decl)} ${cite(x)}`);
  for (const inc of p.includes.filter((i) => i.proc === x.qualified)) {
    out.push(
      `- %INCLUDE ${code(inc.name)} → ${inc.resolved ? code(inc.resolved) : m.notFound} ${cite(inc)}`,
    );
  }
  out.push("");
  const calls = p.calls.filter((c) => c.from === x.qualified);
  if (calls.length > 0) {
    out.push(`${m.calls}:`, "");
    out.push(
      ...table(
        [m.colCallee, m.colResolution, m.colSource],
        calls.map((c) => [code(c.to), cell(c.resolution), cite(c)]),
      ),
      "",
    );
  }
  if (x.sql.length > 0) {
    out.push(`${m.sql}:`, "");
    out.push(
      ...table(
        [m.colOp, m.colTables, m.colSql, m.colSource],
        x.sql.map((q) => [q.op, cell(q.tables.join(", ")), code(q.text.slice(0, 160)), cite(q)]),
      ),
      "",
    );
  }
  const io = p.fileUses.filter((u) => u.proc === x.qualified);
  if (io.length > 0) {
    out.push(`${m.fileIo}:`, "");
    out.push(
      ...table(
        [m.colOp, m.colName, m.colDd, m.colSource],
        io.map((u) => [
          `${u.verb}${u.mode ? ` ${u.mode}` : ""}`,
          code(u.fileName),
          code(u.dd),
          cite(u),
        ]),
      ),
      "",
    );
  }
  if (x.onUnits.length > 0) {
    out.push(`${m.onUnits}:`, "");
    out.push(
      ...table(
        [m.colCondition, m.colAction, m.colSource],
        x.onUnits.map((o) => [
          code(`${o.condition}${o.target ? `(${o.target})` : ""}`),
          code(o.action),
          cite(o),
        ]),
      ),
      "",
    );
  }
  return out;
}
