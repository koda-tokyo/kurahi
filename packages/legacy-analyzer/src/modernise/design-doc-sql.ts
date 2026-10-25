// テーブル定義 / Table definitions of the design document: the table list with who accesses each
// table across COBOL, Java, PL/I and JCL, then per table its columns (type, NULL, default, keys,
// comment), constraints, indexes, view sources and the CRUD evidence. Stored routines whose body
// was read (their table access, calls and trigger events), tables that are accessed but not
// defined in the analysed DDL, and DDL the engine did not model are listed at the end.
// Every fact line cites `path:line`.

import type { DocCtx } from "../design-doc-context.js";
import type { SqlTable } from "./types.js";
import { cell, cite, cites, code, table } from "../md.js";
import { modernStrings } from "./doc-i18n.js";
import { compareJoinKeys, foreignKeys, keyOfRelation } from "./jpa-keys.js";
import { accessorLanguage } from "./lang.js";
import { tableRows } from "./plan.js";

export function renderTables(ctx: DocCtx, n: number): string[] {
  const m = modernStrings(ctx.lang);
  const out = [`## ${n}. ${m.tables}`, ""];
  const poly = ctx.poly;
  const rows = poly ? tableRows(poly, ctx.view) : [];
  if (!poly || rows.length === 0) {
    out.push(m.noTables);
    return out;
  }
  out.push(`> ${m.tablesNote}`, "", `### ${n}.1 ${m.tableList}`, "");
  const evidence = ctx.crud.evidence;
  const evOf = (t: string) => evidence.filter((a) => a.target === `table:${t}`);
  const defined = rows.filter((r) => r.definedAt);
  out.push(
    ...table(
      [m.colName, m.colKind, m.colSchema, m.colColumns, m.colComment, m.colAccess, m.colSource],
      defined.map((r) => {
        const t = poly.sql.tables.find((x) => x.name === r.table) as SqlTable;
        return [
          code(t.name),
          t.kind === "view" ? m.view : m.table,
          code(t.schema),
          String(t.columns.length),
          cell(t.comment ?? ""),
          cell(r.accessors.map((a) => `${a.name} ${a.ops}`).join(", ")),
          cites([t, t.commentAt]),
        ];
      }),
    ),
    "",
  );
  defined.forEach((r, k) => {
    const t = poly.sql.tables.find((x) => x.name === r.table) as SqlTable;
    out.push(...tableSpec(ctx, t, `${n}.${k + 2}`, evOf(t.name)));
  });
  const undefinedRows = rows.filter((r) => !r.definedAt && r.accessors.length > 0);
  let next = defined.length + 2;
  if (undefinedRows.length > 0) {
    out.push(`### ${n}.${next++} ${m.undefinedTables}`, "");
    for (const r of undefinedRows) {
      const ev = evOf(r.table);
      out.push(
        `- ${code(r.table)}: ${r.accessors.map((a) => `${a.name} ${a.ops}`).join(", ")} ${cites(
          ev.map((a) => a.loc),
          6,
        )}`,
      );
    }
    out.push("");
  }
  if (poly.sql.routines.length > 0) {
    out.push(`### ${n}.${next++} ${m.routines}`, "");
    out.push(
      ...table(
        [m.colName, m.colKind, m.colFiresOn, m.colTablesOps, m.colRoutineCalls, m.colSource],
        poly.sql.routines.map((r) => [
          code(`${r.schema ? `${r.schema}.` : ""}${r.name}`),
          r.kind,
          r.on ? `${code(r.on)} ${(r.events ?? []).join(", ")}` : "",
          cell(r.access.map((a) => `${a.table} ${a.op}`).join(", ")),
          cell(r.calls.map((c) => c.name).join(", ")),
          cites([r, ...r.access, ...r.calls], 6),
        ]),
      ),
      "",
    );
  }
  const relations = poly.java.relations ?? [];
  if (relations.length > 0) {
    out.push(`### ${n}.${next++} ${m.jpaKeys}`, "", `> ${m.jpaKeysNote}`, "", ...jpaKeys(ctx));
  }
  const gaps = poly.sql.files.flatMap((f) => f.gaps);
  if (gaps.length > 0 || poly.sql.duplicates.length > 0) {
    out.push(`### ${n}.${next} ${m.notModelled}`, "");
    for (const g of gaps) {
      out.push(`- ${cell(g.detail)} ${cite(g)}`);
    }
    for (const d of poly.sql.duplicates) {
      out.push(`- ${code(d.name)}: ${m.duplicate} ${cite(d.first)} ${cite(d)}`);
    }
  }
  return out;
}

// JPA relationships against the DDL's foreign keys (jpa-keys.ts): one row per relation with the
// key it matches or why it is not judged, then the foreign keys no mapping uses.
function jpaKeys(ctx: DocCtx): string[] {
  const m = modernStrings(ctx.lang);
  const poly = ctx.poly;
  if (!poly) {
    return [];
  }
  const keys = foreignKeys(poly.sql);
  const findings = compareJoinKeys(poly.java, poly.sql);
  const missing = new Set(
    findings.flatMap((f) => (f.kind === "join without foreign key" ? [f.relation] : [])),
  );
  const q = (name: string, schema?: string) => `${schema ? `${schema}.` : ""}${name}`;
  const out = table(
    [m.colMapping, m.colJoinColumns, m.colReferences, m.colForeignKey, m.colSource],
    (poly.java.relations ?? []).map((r) => {
      const key = r.target ? keyOfRelation(r, keys) : undefined;
      const status = !r.target
        ? m.targetNotEntity
        : missing.has(r)
          ? m.keyMissing
          : key
            ? `${m.keyMatches} ${cite(key)}`
            : m.keyNotJudged;
      return [
        code(`${r.type.split(".").pop()}${r.field ? `.${r.field}` : ""} @${r.kind}`),
        `${code(`${q(r.table, r.schema)}(${r.columns.join(", ")})`)}${r.implicit ? ` ${m.implicit}` : ""}${r.joinTable ? ` ${m.joinTable}` : ""}`,
        r.target
          ? code(
              `${q(r.target, r.targetSchema)}${r.referenced ? `(${r.referenced.join(", ")})` : ""}`,
            )
          : code(r.unresolved),
        status,
        cite(r),
      ];
    }),
  );
  out.push("");
  const unused = findings.flatMap((f) => (f.kind === "foreign key without mapping" ? [f.key] : []));
  if (unused.length > 0) {
    out.push(`${m.unusedKeys}:`, "");
    for (const k of unused) {
      out.push(
        `- ${code(`${q(k.table, k.schema)}(${k.columns.join(", ")}) -> ${q(k.target, k.targetSchema)}${k.referenced.length ? `(${k.referenced.join(", ")})` : ""}`)} ${cite(k)}`,
      );
    }
    out.push("");
  }
  return out;
}

function tableSpec(
  ctx: DocCtx,
  t: SqlTable,
  num: string,
  ev: DocCtx["crud"]["evidence"],
): string[] {
  const m = modernStrings(ctx.lang);
  const out = [`### ${num} ${t.schema ? `${t.schema}.` : ""}${t.name}`, ""];
  out.push(
    t.comment
      ? `- ${m.colComment}: ${cell(t.comment)} ${cites([t.commentAt])}`
      : `- ${m.colComment}: ${m.tbc} ${cite(t)}`,
  );
  if (t.kind === "view") {
    out.push(`- ${m.viewSources}: ${t.sources.map(code).join(" ")} ${cite(t)}`, "");
  }
  if (t.columns.length > 0) {
    const fkCols = new Set(
      t.constraints.filter((c) => c.kind === "FOREIGN KEY").flatMap((c) => c.columns),
    );
    out.push(
      "",
      ...table(
        [
          m.colNo,
          m.colColumn,
          m.colType,
          m.colNull,
          m.colDefault,
          m.colKey,
          m.colComment,
          m.colSource,
        ],
        t.columns.map((c, i) => [
          String(i + 1),
          code(c.name),
          code(c.type),
          c.nullable === false ? m.no : c.nullable === true ? m.yes : m.unknown,
          code(c.default),
          [
            c.primaryKey ? m.pk : "",
            c.references || fkCols.has(c.name) ? m.fk : "",
            c.unique ? m.uk : "",
          ]
            .filter(Boolean)
            .join(","),
          cell(c.comment ?? ""),
          cites([c, c.commentAt]),
        ]),
      ),
      "",
    );
  }
  const cons = [
    ...t.constraints.map((c) => ({
      loc: c,
      text: `${c.kind}${c.name ? ` ${c.name}` : ""} (${c.columns.join(", ")})${c.references ? ` -> ${c.references.table}(${c.references.columns.join(", ")})` : ""}${c.text ? ` ${c.text}` : ""}`,
    })),
    ...t.columns
      .filter((c) => c.references)
      .map((c) => ({
        loc: c,
        text: `FOREIGN KEY (${c.name}) -> ${c.references?.table}${c.references?.column ? `(${c.references.column})` : ""}`,
      })),
  ];
  if (cons.length > 0) {
    out.push(`${m.constraints}:`, "");
    for (const c of cons) {
      out.push(`- ${code(c.text)} ${cite(c.loc)}`);
    }
    out.push("");
  }
  const idx = ctx.poly?.sql.indexes.filter((i) => i.table === t.name) ?? [];
  if (idx.length > 0) {
    out.push(`${m.indexes}:`, "");
    for (const i of idx) {
      out.push(
        `- ${code(`${i.unique ? "UNIQUE " : ""}${i.name} (${i.columns.join(", ")})`)} ${cite(i)}`,
      );
    }
    out.push("");
  }
  if (ev.length > 0) {
    out.push(`${m.access}:`, "");
    out.push(
      ...table(
        [m.colProgram, m.colLanguage, m.colOps, m.colVia, m.colWhere, m.colSource],
        ev.map((a) => {
          const pn = ctx.view.node.get(a.program);
          return [
            code(
              pn?.kind === "java-type" ? a.program.replace(/^type:/, "") : (pn?.name ?? a.program),
            ),
            accessorLanguage(pn),
            a.op,
            cell(a.via),
            code(a.paragraph),
            cite(a.loc),
          ];
        }),
      ),
      "",
    );
  }
  return out;
}
