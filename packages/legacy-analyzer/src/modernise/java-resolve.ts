// Java facts across files: type-name resolution (nested types, imports, same package, wildcard
// imports), call edges where the target is statically known, and table access (JPA entities and
// columns, Spring Data repositories, @Query, JDBC SQL in literals and String constants). A call is
// resolved only when its receiver's declared type is in the sources: bare calls (same class,
// known supertypes, enclosing types, static imports), this/super, fields and parameters with a
// declared type, a type name, or a fully qualified name. Everything else is listed as unresolved.

import type { Loc } from "../types.js";
import type { JavaCall, JavaFile, JavaMethod, JavaType, SqlUse } from "./types.js";
import {
  INHERITED,
  type JavaAnalysis,
  type JavaColumnMap,
  type JavaSupertype,
  type JavaTableUse,
  REPO_BASES,
  type ResolvedCall,
  STEREOTYPES,
  type UnresolvedCall,
  ann,
  derivedOps,
  last,
  methodId,
  opsOfSql,
  springName,
  typeIndex,
} from "./java-names.js";
import { canonical, sqlTables } from "./sql-text.js";

export type { JavaAnalysis, JavaTableUse, ResolvedCall, UnresolvedCall } from "./java-names.js";
export { methodId, opsOfSql, springName } from "./java-names.js";

export function analyseJava(files: JavaFile[]): JavaAnalysis {
  const { types, byQn, fileOf, resolveType, supers, arityOk, methodsIn } = typeIndex(files);
  const repoEntity = new Map<string, JavaType>();
  const entityTable = new Map<string, string>();
  const entityName = new Map<string, string>();
  const stereotypes: Record<string, string[]> = {};
  const tableUses: JavaTableUse[] = [];
  const columns: JavaColumnMap[] = [];

  const supertypes: JavaSupertype[] = [];
  for (const t of types) {
    for (const [kind, list] of [
      ["EXTENDS", t.extends],
      ["IMPLEMENTS", t.implements],
    ] as const) {
      for (const name of list) {
        const r = resolveType(name, t);
        supertypes.push({
          file: t.file,
          line: t.line,
          type: t.qualifiedName,
          kind,
          name,
          ...(r ? { resolved: r.qualifiedName } : {}),
        });
      }
    }
    const st = STEREOTYPES.filter((s) => ann(t, s));
    const entity = ann(t, "Entity");
    if (entity) {
      const table = ann(t, "Table");
      const tname = table?.args.name ?? table?.args.value;
      const ename = entity.args.name ?? t.name;
      const canon = tname ? canonical(tname) : springName(ename);
      entityTable.set(t.qualifiedName, canon);
      entityName.set(ename.toUpperCase(), canon);
      tableUses.push({
        file: (table ?? entity).file,
        line: (table ?? entity).line,
        type: t.qualifiedName,
        table: canon,
        ops: [],
        kind: "entity",
        via: tname ? "@Table" : "@Entity (default name)",
      });
      for (const f of t.fields) {
        if (
          f.modifiers.includes("static") ||
          f.modifiers.includes("transient") ||
          ann(f, "Transient", "OneToMany", "ManyToMany")
        ) {
          continue;
        }
        const col = ann(f, "Column", "JoinColumn");
        const cname = col?.args.name;
        columns.push({
          file: f.file,
          line: f.line,
          type: t.qualifiedName,
          field: f.name,
          table: canon,
          column: cname ? canonical(cname) : springName(f.name),
          implicit: !cname,
        });
      }
    }
    for (const base of t.kind === "interface" ? t.implements : []) {
      const m = /^([\w.]+)\s*<\s*([\w.]+)/.exec(base);
      if (m && REPO_BASES.has(last(m[1]))) {
        const e = resolveType(m[2], t);
        if (e) {
          repoEntity.set(t.qualifiedName, e);
        }
        st.push("Spring Data repository");
      }
    }
    if (st.length > 0) {
      stereotypes[t.qualifiedName] = st;
    }
  }
  const tableOfEntity = (e: JavaType | undefined) =>
    e ? entityTable.get(e.qualifiedName) : undefined;
  for (const [repo, e] of repoEntity) {
    const t = byQn.get(repo) as JavaType;
    const table = tableOfEntity(e);
    if (table) {
      tableUses.push({
        file: t.file,
        line: t.line,
        type: repo,
        table,
        ops: [],
        kind: "repository",
        via: `Spring Data repository of ${e.name}`,
      });
    }
  }

  const calls: ResolvedCall[] = [];
  const unresolved: UnresolvedCall[] = [];
  const access = (
    t: JavaType,
    m: JavaMethod | undefined,
    use: Omit<JavaTableUse, "type" | "method" | "kind">,
  ) =>
    tableUses.push({
      ...use,
      type: t.qualifiedName,
      ...(m ? { method: m.signature } : {}),
      kind: "access",
    });
  const sqlAccess = (
    t: JavaType,
    m: JavaMethod | undefined,
    s: SqlUse,
    tables: string[],
    via: string,
  ) => {
    for (const table of tables) {
      access(t, m, {
        file: s.file,
        line: s.line,
        table,
        ops: opsOfSql(s.op),
        via,
        sqlOp: s.op,
        text: s.text,
        ...(s.partial ? { partial: true } : {}),
        ...(s.declaredAt ? { declaredAt: s.declaredAt } : {}),
      });
    }
  };

  // Repository methods first (derived queries and @Query), so callers can inherit their access.
  const methodAccess = new Map<string, JavaTableUse[]>();
  for (const t of types) {
    const e = repoEntity.get(t.qualifiedName);
    for (const m of t.methods) {
      const before = tableUses.length;
      const query = ann(m, "Query");
      if (query) {
        const text = query.args.value ?? "";
        const native = query.args.nativeQuery === "true";
        const sql = sqlTables(text);
        // JPQL names entities: only names of entities in the sources map to tables (a path join
        // such as `JOIN e.dept d` or an entity outside the sources makes the fact partial).
        const mapped = sql.tables.filter((x) => entityName.has(x));
        const tables = native ? sql.tables : mapped.map((x) => entityName.get(x) as string);
        const use: SqlUse = {
          file: query.file,
          line: query.line,
          text: text.replace(/\s+/g, " ").trim(),
          op: sql.op,
          tables,
          via: native ? "native" : "jpql",
          ...(!native && mapped.length < sql.tables.length ? { partial: true } : {}),
        };
        sqlAccess(t, m, use, tables, `@Query ${native ? "native " : ""}${sql.op}`);
      } else if (e && tableOfEntity(e)) {
        const ops = derivedOps(m.name);
        if (ops) {
          access(t, m, {
            file: m.file,
            line: m.line,
            table: tableOfEntity(e) as string,
            ops,
            via: `derived query ${m.name}`,
          });
        }
      }
      if (tableUses.length > before) {
        methodAccess.set(methodId(t.qualifiedName, m), tableUses.slice(before));
      }
    }
  }

  for (const t of types) {
    const tSupers = supers(t);
    const outers: JavaType[] = [];
    for (
      let o = t.outer ? byQn.get(t.outer) : undefined;
      o;
      o = o.outer ? byQn.get(o.outer) : undefined
    ) {
      outers.push(o);
    }
    const fieldType = (name: string): JavaType | undefined => {
      for (const owner of [t, ...tSupers, ...outers]) {
        const f = owner.fields.find((x) => x.name === name);
        if (f) {
          return resolveType(f.type, owner);
        }
      }
      return undefined;
    };
    const constants = new Map(
      [t, ...outers].flatMap((o) =>
        o.fields.filter((f) => f.stringValue !== undefined).map((f) => [f.name, f] as const),
      ),
    );
    const usedConstants = new Set<string>();
    for (const m of t.methods) {
      const from = methodId(t.qualifiedName, m);
      for (const c of m.calls) {
        const r = resolveCall(c, m);
        if (r.to.length > 0) {
          calls.push({
            file: c.file,
            line: c.line,
            from,
            to: r.to,
            name: c.name,
            resolution: r.how,
          });
        } else {
          unresolved.push({
            file: c.file,
            line: c.line,
            from,
            name: c.name,
            ...(c.qualifier ? { qualifier: c.qualifier } : {}),
            form: c.form,
            reason: r.how,
          });
        }
        // Repository calls: the caller reads or writes what the repository method does.
        const repoT = r.receiver;
        const e = repoT ? repoEntity.get(repoT.qualifiedName) : undefined;
        if (repoT && c.form === "call") {
          const own = r.to.flatMap((x) => methodAccess.get(x) ?? []);
          for (const u of own) {
            access(t, m, {
              file: c.file,
              line: c.line,
              table: u.table,
              ops: u.ops,
              via: `${repoT.name}.${c.name}`,
            });
          }
          const table = tableOfEntity(e);
          if (own.length === 0 && r.to.length === 0 && table && INHERITED[c.name]) {
            access(t, m, {
              file: c.file,
              line: c.line,
              table,
              ops: INHERITED[c.name],
              via: `${repoT.name}.${c.name} (inherited)`,
            });
          }
        }
      }
      for (const s of m.sql) {
        sqlAccess(t, m, s, s.tables, `JDBC ${s.op}`);
      }
      for (const r of m.refs) {
        const f = constants.get(r.name);
        const sql = f?.stringValue !== undefined ? sqlTables(f.stringValue) : undefined;
        if (
          f &&
          sql &&
          sql.tables.length > 0 &&
          /^(SELECT|INSERT|UPDATE|DELETE|MERGE|WITH)$/.test(sql.op)
        ) {
          usedConstants.add(f.name);
          const use: SqlUse = {
            file: r.file,
            line: r.line,
            text: (f.stringValue ?? "").replace(/\s+/g, " ").trim(),
            op: sql.op,
            tables: sql.tables,
            via: "constant",
            declaredAt: { file: f.file, line: f.line },
          };
          sqlAccess(t, m, use, sql.tables, `JDBC ${sql.op} (constant ${f.name})`);
        }
      }
    }
    // SQL constants never referenced in a method: reported where they are declared.
    for (const f of t.fields) {
      if (f.stringValue === undefined || usedConstants.has(f.name)) {
        continue;
      }
      const sql = sqlTables(f.stringValue);
      if (sql.tables.length > 0 && /^(SELECT|INSERT|UPDATE|DELETE|MERGE|WITH)$/.test(sql.op)) {
        const use: SqlUse = {
          file: f.file,
          line: f.line,
          text: f.stringValue.replace(/\s+/g, " ").trim(),
          op: sql.op,
          tables: sql.tables,
          via: "constant",
        };
        sqlAccess(
          t,
          undefined,
          use,
          sql.tables,
          `SQL constant ${f.name} (no method reference found)`,
        );
      }
    }

    function resolveCall(
      c: JavaCall,
      m: JavaMethod,
    ): { to: string[]; how: string; receiver?: JavaType } {
      if (c.form === "new") {
        const nt = resolveType(c.qualifier ? `${c.qualifier}.${c.name}` : c.name, t);
        if (!nt) {
          return { to: [], how: "type not in the sources" };
        }
        const ctors = nt.methods.filter((x) => x.kind === "constructor" && arityOk(x, c.args));
        return {
          to: ctors.length ? ctors.map((x) => methodId(nt.qualifiedName, x)) : [nt.qualifiedName],
          how: ctors.length ? "constructor" : "default constructor",
        };
      }
      const inType = (rt: JavaType, how: string) => {
        const to = methodsIn([rt, ...supers(rt)], c.name, c.args);
        return to.length
          ? { to, how, receiver: rt }
          : {
              to: [],
              how: `${c.name} is not declared in ${rt.name} or its known supertypes${supertypes.some((x) => x.type === rt.qualifiedName && !x.resolved) ? " (it may come from a supertype outside the sources)" : ""}`,
              receiver: rt,
            };
      };
      const q = c.qualifier;
      if (!q) {
        const own = methodsIn([t, ...tSupers], c.name, c.args);
        if (own.length) {
          return {
            to: own,
            how: methodsIn([t], c.name, c.args).length ? "same class" : "inherited",
          };
        }
        const enc = methodsIn(outers, c.name, c.args);
        if (enc.length) {
          return { to: enc, how: "enclosing type" };
        }
        for (const imp of fileOf.get(t.qualifiedName)?.imports.filter((i) => i.static) ?? []) {
          const owner = imp.wildcard ? imp.name : imp.name.split(".").slice(0, -1).join(".");
          const member = imp.wildcard ? c.name : imp.name.split(".").pop();
          const ot = byQn.get(owner);
          if (ot && member === c.name) {
            const to = methodsIn([ot], c.name, c.args);
            if (to.length) {
              return { to, how: "static import" };
            }
          }
        }
        return { to: [], how: "not declared in the type, its known supertypes or static imports" };
      }
      if (q === "this") {
        return inType(t, "this");
      }
      if (q === "super") {
        const st = tSupers[0];
        return st ? inType(st, "super") : { to: [], how: "supertype not in the sources" };
      }
      if (q.startsWith("<expr>")) {
        return { to: [], how: "receiver is an expression (its type is not computed)" };
      }
      const parts = q.split(".");
      if (parts.length === 2 && parts[0] === "this") {
        const ft = fieldType(parts[1]);
        return ft
          ? inType(ft, "field type")
          : { to: [], how: `type of field ${parts[1]} not in the sources` };
      }
      if (parts.length === 1) {
        const p = m.params.find((x) => x.name === q);
        if (p) {
          const pt = resolveType(p.type, t);
          return pt
            ? inType(pt, "parameter type")
            : { to: [], how: `type of parameter ${q} (${p.type}) not in the sources` };
        }
        const ft = fieldType(q);
        if (ft) {
          return inType(ft, "field type");
        }
      }
      const tt = resolveType(q, t);
      if (tt) {
        return inType(tt, parts.length > 1 && byQn.has(q) ? "qualified name" : "type name");
      }
      return {
        to: [],
        how: /^[a-z]/.test(q)
          ? "receiver is a local variable or a type outside the sources"
          : "type not in the sources",
      };
    }
  }

  const byLoc = <T extends Loc>(a: T, b: T) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line;
  return {
    model: { files, types },
    calls: calls.toSorted(byLoc),
    unresolved: unresolved.toSorted(byLoc),
    tableUses: tableUses.toSorted(
      (a, b) => byLoc(a, b) || (a.table < b.table ? -1 : a.table > b.table ? 1 : 0),
    ),
    columns: columns.toSorted(byLoc),
    supertypes,
    stereotypes,
  };
}
