// FORTRAN プログラム単位仕様 / FORTRAN program units of the design document: the unit list, the
// COMMON block map (each unit's member layout, with the layout check), then per unit its purpose
// (the comment above the header, or an explicit placeholder), declaration, IMPLICIT rule, USE and
// INCLUDE, calls, declarations and file I/O, and finally what the engine did not model. Every
// fact line cites `path:line`.

import type { DocCtx } from "../design-doc-context.js";
import type { FortranAnalysis } from "./fortran-resolve.js";
import { cell, cite, cites, code, table } from "../md.js";
import { sciStrings } from "./doc-i18n-sci.js";
import { memberText } from "./fortran-resolve.js";

type Unit = FortranAnalysis["units"][number];

export function renderFortran(ctx: DocCtx, n: number): string[] {
  const m = sciStrings(ctx.lang);
  const out = [`## ${n}. ${m.fortran}`, ""];
  const f = ctx.poly?.fortran;
  if (!f || f.units.length === 0) {
    out.push(m.noFortran);
    return out;
  }
  const byId = new Map(f.units.map((u) => [u.id, u]));
  const implicitText = (u: Unit): string => {
    if (u.implicit) {
      return u.implicit === "NONE" ? m.implicitNone : u.implicit;
    }
    const host = u.host ? byId.get(u.host) : undefined;
    return host?.implicit ? `${implicitText(host)} (${m.inherited(host.id)})` : m.implicitDefault;
  };
  out.push(`> ${m.fortranNote}`, "", `### ${n}.1 ${m.unitList}`, "");
  out.push(
    ...table(
      [
        m.colUnit,
        m.colKind,
        m.colHost,
        m.colImplicit,
        m.colCalls,
        m.colCommon,
        m.colFiles,
        m.colSource,
      ],
      f.units.map((u) => [
        code(u.id),
        u.kind,
        code(u.host),
        cell(implicitText(u)),
        cell([...new Set(f.calls.filter((c) => c.from === u.id).map((c) => c.to))].join(", ")),
        cell(
          f.commons
            .filter((c) => c.users.some((x) => x.unit === u.id))
            .map((c) => `/${c.name === "//" ? "" : c.name}/`)
            .join(" "),
        ),
        cell(
          [...new Set(f.fileUses.filter((x) => x.unit === u.id).map((x) => x.target.name))].join(
            ", ",
          ),
        ),
        cite(u),
      ]),
    ),
    "",
  );
  out.push(`### ${n}.2 ${m.commonMap}`, "");
  if (f.commons.length === 0) {
    out.push(ctx.s.none, "");
  }
  for (const c of f.commons) {
    out.push(
      `- ${code(`/${c.name === "//" ? "" : c.name}/`)}: ${m.layout(c.layout)} ${cites(c.users)}`,
      "",
    );
    out.push(
      ...table(
        [m.colUnit, m.colMembers, m.colVia, m.colSource],
        c.users.map((u) => [
          code(u.unit),
          cell(u.members.map(memberText).join(", ")),
          code(u.via),
          cite(u),
        ]),
      ),
      "",
    );
  }
  f.units.forEach((u, k) => out.push(...unitSpec(ctx, f, u, `${n}.${k + 3}`, implicitText(u))));
  out.push(...notModelled(ctx, f, `${n}.${f.units.length + 3}`));
  return out;
}

function unitSpec(
  ctx: DocCtx,
  f: FortranAnalysis,
  u: Unit,
  num: string,
  implicit: string,
): string[] {
  const m = sciStrings(ctx.lang);
  const out = [`### ${num} ${u.id}`, ""];
  out.push(
    u.doc
      ? `- ${m.purpose}: ${cell(u.doc)} ${m.fromComment} ${cite(u)}`
      : `- ${m.purpose}: ${m.tbc} ${cite(u)}`,
  );
  const head = [
    u.resultType ?? "",
    ...u.prefixes,
    u.kind === "block-data" ? "BLOCK DATA" : u.kind.toUpperCase(),
    `${u.name}${u.kind === "subroutine" || u.kind === "function" ? `(${u.args.join(", ")})` : ""}`,
  ]
    .filter(Boolean)
    .join(" ");
  out.push(`- ${m.declaration}: ${code(head)} ${cite(u)}`);
  out.push(`- ${m.colImplicit}: ${cell(implicit)} ${cite(u.implicitAt ?? u)}`);
  for (const x of f.uses.filter((y) => y.unit === u.id)) {
    const use = u.uses.find((y) => y.line === x.line && y.module === x.module);
    out.push(
      `- ${m.uses}: ${code(x.module)}${use?.only ? ` ONLY ${code(use.only.join(", "))}` : ""} ${cite(x)}`,
    );
  }
  for (const x of f.includes.filter((y) => y.unit === u.id)) {
    out.push(
      `- ${m.includes}: ${code(x.name)} → ${x.resolved ? code(x.resolved) : m.notFound} ${cite(x)}`,
    );
  }
  for (const e of u.equivalences) {
    out.push(
      `- ${m.equivalence}: ${code(e.groups.map((g) => `(${g.join(", ")})`).join(", "))} ${cite(e)}`,
    );
  }
  if (u.entries.length > 0) {
    out.push(`- ${m.entries}: ${u.entries.map((e) => code(e.name)).join(" ")} ${cites(u.entries)}`);
  }
  out.push("");
  const calls = f.calls.filter((c) => c.from === u.id);
  if (calls.length > 0) {
    out.push(`${m.calls}:`, "");
    out.push(
      ...table(
        [m.colCallee, m.colForm, m.colResolution, m.colSource],
        calls.map((c) => [code(c.to), c.form, cell(c.resolution), cite(c)]),
      ),
      "",
    );
  }
  if (u.decls.length > 0) {
    out.push(`${m.declarations}:`, "");
    out.push(
      ...table(
        [m.colName, m.colType, m.colDims, m.colAttrs, m.colSource],
        u.decls.map((d) => [
          code(d.name),
          code(d.type),
          code(d.dims),
          cell([...d.attrs, ...(d.value !== undefined ? [`= ${d.value}`] : [])].join(", ")),
          cite(d),
        ]),
      ),
      "",
    );
  }
  const io = f.fileUses.filter((x) => x.unit === u.id);
  if (io.length > 0) {
    out.push(`${m.fileIo}:`, "");
    out.push(
      ...table(
        [m.colOp, m.colTarget, m.colBinding, m.colSource],
        io.map((x) => [
          x.op,
          code(x.target.kind === "dd" ? `DD ${x.target.name}` : x.target.name),
          cell(`${x.binding}${x.op === "OPEN" && x.status ? ` (STATUS=${x.status})` : ""}`),
          cite(x),
        ]),
      ),
      "",
    );
  }
  return out;
}

function notModelled(ctx: DocCtx, f: FortranAnalysis, num: string): string[] {
  const m = sciStrings(ctx.lang);
  // Calls that reach no program of the project (a COBOL or PL/I program of that name is in it).
  const external = f.calls.filter(
    (c) =>
      c.resolution === "not in the FORTRAN sources" &&
      ctx.view.node.get(`program:${c.to}`)?.kind !== "program",
  );
  const missing = f.includes.filter((i) => !i.resolved);
  if (f.gaps.length + f.unresolvedIo.length + external.length + missing.length === 0) {
    return [];
  }
  const out = [`### ${num} ${m.notModelled}`, ""];
  for (const g of f.gaps) {
    out.push(`- ${code(g.construct)}: ${cell(g.detail)} ${cite(g)}`);
  }
  for (const x of f.unresolvedIo) {
    out.push(`- ${m.unresolvedIo}: ${code(x.unit)} ${x.op}: ${cell(x.reason)} ${cite(x)}`);
  }
  for (const c of external) {
    out.push(`- ${m.externalCalls}: ${code(c.from)} → ${code(c.name)} ${cite(c)}`);
  }
  for (const i of missing) {
    out.push(`- ${m.includes} ${code(i.name)}: ${m.notFound} ${cite(i)}`);
  }
  out.push("");
  return out;
}
