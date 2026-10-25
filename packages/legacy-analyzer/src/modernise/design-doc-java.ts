// クラス仕様 / Java class specifications of the design document: the class list, then per type
// its declaration, purpose (the Javadoc sentence, or an explicit placeholder), the table it maps,
// fields with their column mapping, and methods with their resolved calls and table access.
// Every fact line cites `path:line`.

import type { DocCtx } from "../design-doc-context.js";
import type { JavaType } from "./types.js";
import { cell, cite, cites, code, table } from "../md.js";
import { modernStrings } from "./doc-i18n.js";
import { methodId } from "./java-resolve.js";

export function renderJava(ctx: DocCtx, n: number): string[] {
  const m = modernStrings(ctx.lang);
  const out = [`## ${n}. ${m.java}`, ""];
  const java = ctx.poly?.java;
  if (!java || java.model.types.length === 0) {
    out.push(m.noJava);
    return out;
  }
  out.push(`> ${m.javaNote}`, "", `### ${n}.1 ${m.classList}`, "");
  const types = java.model.types;
  out.push(
    ...table(
      [
        m.colType,
        m.colKind,
        m.colPackage,
        m.colStereotypes,
        m.colMethods,
        m.colFields,
        m.colSource,
      ],
      types.map((t) => [
        code(t.outer ? t.qualifiedName.slice((t.package?.length ?? -1) + 1) : t.name),
        t.kind,
        code(t.package),
        cell((java.stereotypes[t.qualifiedName] ?? []).join(", ")),
        String(t.methods.length),
        String(t.fields.length),
        cite(t),
      ]),
    ),
    "",
  );
  types.forEach((t, k) => out.push(...typeSpec(ctx, t, `${n}.${k + 2}`)));
  return out;
}

function typeSpec(ctx: DocCtx, t: JavaType, num: string): string[] {
  const m = modernStrings(ctx.lang);
  const java = ctx.poly?.java;
  if (!java) {
    return [];
  }
  const out = [`### ${num} ${t.qualifiedName}`, ""];
  out.push(
    t.doc
      ? `- ${m.purpose}: ${cell(t.doc)} ${m.fromDoc} ${cite(t)}`
      : `- ${m.purpose}: ${m.tbc} ${cite(t)}`,
  );
  const decl = [
    t.modifiers.join(" "),
    t.kind,
    t.name + (t.typeParams ?? ""),
    t.extends.length ? `${m.extendsLabel} ${t.extends.join(", ")}` : "",
    t.implements.length ? `${m.implementsLabel} ${t.implements.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  out.push(`- ${m.declaration}: ${code(decl)} ${cite(t)}`);
  if (t.annotations.length > 0) {
    out.push(
      `- ${m.colAnnotations}: ${t.annotations
        .map((a) =>
          code(
            `@${a.name}${
              Object.keys(a.args).length
                ? `(${Object.entries(a.args)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(", ")})`
                : ""
            }`,
          ),
        )
        .join(" ")} ${cites(t.annotations)}`,
    );
  }
  for (const u of java.tableUses.filter((x) => x.type === t.qualifiedName && x.kind !== "access")) {
    const d = u.discriminator;
    const disc = d
      ? `; ${m.discriminator(d.column, d.value, d.implicit, d.abstract)}${d.duplicate ? ` ${m.duplicateDiscriminator}` : ""}`
      : "";
    out.push(`- ${m.mapsTo}: ${code(u.table)} (${cell(`${u.via}${disc}`)}) ${cite(u)}`);
  }
  if (t.enumConstants.length > 0) {
    out.push(
      `- ${m.enumConstants}: ${t.enumConstants.map((c) => code(c.name)).join(" ")} ${cites(t.enumConstants)}`,
    );
  }
  if (t.recordComponents.length > 0) {
    out.push(
      `- ${m.recordComponents}: ${t.recordComponents.map((c) => code(`${c.type} ${c.name}`)).join(" ")} ${cite(t)}`,
    );
  }
  out.push("");
  if (t.fields.length > 0) {
    // A field's columns: its own, or each of an embedded field's (field path "address.street").
    const own = java.columns.filter((c) => c.type === t.qualifiedName);
    const colsOf = (name: string) =>
      own.filter((c) => c.field === name || c.field.startsWith(`${name}.`));
    out.push(
      ...table(
        [m.colName, m.colType, m.colAnnotations, m.colColumn, m.colSource],
        t.fields.map((f) => {
          return [
            code(f.name),
            code(f.type),
            cell(f.annotations.map((a) => `@${a.name}`).join(" ")),
            colsOf(f.name)
              .map(
                (c) =>
                  `${code(`${c.table}.${c.column}`)}${c.implicit ? ` (${m.implicit})` : ""}${c.stores ? ` ${code(c.stores)}` : ""}`,
              )
              .join(" "),
            cite(f),
          ];
        }),
      ),
      "",
    );
  }
  if (t.methods.length > 0) {
    const calls = new Map<string, string[]>();
    for (const c of java.calls) {
      if (c.from.startsWith(`${t.qualifiedName}#`)) {
        const short = c.to.map((x) => x.split(".").pop() ?? x);
        calls.set(c.from, [...(calls.get(c.from) ?? []), ...short]);
      }
    }
    out.push(
      ...table(
        [m.colName, m.colReturn, m.colAnnotations, m.colCalls, m.colTables, m.colSource],
        t.methods.map((x) => {
          const id = methodId(t.qualifiedName, x);
          const uses = java.tableUses.filter(
            (u) => u.type === t.qualifiedName && u.method === x.signature && u.kind === "access",
          );
          const crud = new Map<string, Set<string>>();
          for (const u of uses) {
            const s = crud.get(u.table) ?? new Set<string>();
            u.ops.forEach((o) => s.add(o));
            crud.set(u.table, s);
          }
          return [
            code(x.signature),
            code(x.returnType ?? ""),
            cell(x.annotations.map((a) => `@${a.name}`).join(" ")),
            cell([...new Set(calls.get(id) ?? [])].join(", ")),
            cell(
              [...crud]
                .map(
                  ([tb, ops]) =>
                    `${tb} ${["C", "R", "U", "D", "?"].filter((o) => ops.has(o)).join("")}`,
                )
                .join(", "),
            ),
            cites([x, ...uses]),
          ];
        }),
      ),
      "",
    );
  }
  for (const x of t.methods) {
    for (const q of x.sql.filter((y) => y.partial)) {
      out.push(`- ${m.partialSql(x.signature)}: ${code(q.text)} ${cite(q)}`, "");
    }
  }
  const un = java.unresolved.filter((u) => u.from.startsWith(`${t.qualifiedName}#`));
  if (un.length > 0) {
    out.push(`- ${m.colUnresolved}: ${m.unresolvedLine(un.length)} ${cites(un, 4)}`, "");
  }
  return out;
}
