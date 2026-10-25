// Java facts across files: type-name resolution (nested types, imports, same package, wildcard
// imports), call edges where the target is statically known, and table access (JPA entities and
// columns, Spring Data repositories, @Query, JDBC SQL in literals and String constants). A call is
// resolved only when its receiver's declared type is in the sources: bare calls (same class,
// known supertypes, enclosing types, static imports), this/super, fields and parameters with a
// declared type, a type name, or a fully qualified name. Everything else is listed as unresolved.

import type { Loc } from "../types.js";
import type { MyBatisMapper } from "./java-mybatis.js";
import type {
  JavaAnnotation,
  JavaCall,
  JavaField,
  JavaFile,
  JavaMethod,
  JavaType,
  SqlUse,
} from "./types.js";
import {
  INHERITED,
  type JavaAnalysis,
  type JavaColumnMap,
  type JavaRelation,
  type JavaRoutineCall,
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
  repeated,
  springName,
  typeIndex,
} from "./java-names.js";
import { canonical, routineCall, sqlTables, tableSchemas } from "./sql-text.js";

export type {
  JavaAnalysis,
  JavaRelation,
  JavaTableUse,
  ResolvedCall,
  UnresolvedCall,
} from "./java-names.js";
export { methodId, opsOfSql, springName } from "./java-names.js";

export function analyseJava(files: JavaFile[], mappers: MyBatisMapper[] = []): JavaAnalysis {
  const { types, byQn, fileOf, resolveType, supers, arityOk, methodsIn } = typeIndex(files);
  const repoEntity = new Map<string, JavaType>();
  const entityTable = new Map<string, string>();
  const entityName = new Map<string, string>();
  const entitySchema = new Map<string, string>();
  const stereotypes: Record<string, string[]> = {};
  const tableUses: JavaTableUse[] = [];
  const columns: JavaColumnMap[] = [];
  const relations: JavaRelation[] = [];

  // @Entity's table: @Table(schema = "payroll", name = "employee"), @Table(name =
  // "payroll.employee"), or Spring Boot's default physical name of the entity name.
  function entityMapping(
    t: JavaType,
  ): { table: string; schema?: string; named: boolean } | undefined {
    const entity = ann(t, "Entity");
    if (!entity) {
      return undefined;
    }
    // A SINGLE_TABLE subclass maps to its hierarchy root's table; its own @Table does not apply.
    const root = rootEntity(t);
    if (root !== t && strategyOf(root) === "SINGLE_TABLE") {
      return entityMapping(root);
    }
    const table = ann(t, "Table");
    const tname = table?.args.name ?? table?.args.value;
    const dotted = tname?.split(".");
    const sname = table?.args.schema || (dotted && dotted.length > 1 ? dotted.at(-2) : undefined);
    return {
      table: tname ? canonical(tname) : springName(entity.args.name ?? t.name),
      schema: sname ? canonical(sname) : undefined,
      named: Boolean(tname),
    };
  }
  // JPA inheritance: an entity's superclass when that is an @Entity too, the hierarchy's root and
  // the root's strategy (@Inheritance(strategy = ...); SINGLE_TABLE when not given).
  const superOf = (t: JavaType) => (t.extends[0] ? resolveType(t.extends[0], t) : undefined);
  // The @MappedSuperclass types directly above a type, nearest first: their persistent fields
  // (the @Id and relationships included) belong to each entity subclass's own table.
  function mappedSupers(t: JavaType) {
    const out: JavaType[] = [];
    for (
      let p = superOf(t);
      p && p !== t && !out.includes(p) && ann(p, "MappedSuperclass");
      p = superOf(p)
    ) {
      out.push(p);
    }
    return out;
  }
  // The fields an entity type maps itself: its mapped superclasses' (farthest first), then its own.
  const ownFields = (t: JavaType) => [
    ...mappedSupers(t)
      .toReversed()
      .flatMap((x) => x.fields),
    ...t.fields,
  ];
  // @AttributeOverride(s) on an entity or an embedded field: attribute name (a path into an
  // embeddable for "address.street") -> the column the override names.
  const overrides = (t: { annotations: JavaAnnotation[] }) =>
    new Map(
      repeated(t, "AttributeOverride", "AttributeOverrides").flatMap((a) => {
        const col = a.nested?.find((x) => x.element === "column")?.args.name;
        return a.args.name && col ? [[a.args.name, canonical(col)] as const] : [];
      }),
    );
  // @AssociationOverride(s) on an entity or an embedded field: the to-one attribute it names (a
  // path into an embeddable, or a mapped superclass's field) -> the join columns that replace the
  // attribute's own @JoinColumn(s).
  const joinOverrides = (t: { annotations: JavaAnnotation[] }) =>
    new Map(
      repeated(t, "AssociationOverride", "AssociationOverrides").flatMap((a) => {
        const joins = (a.nested ?? []).filter((x) => x.element === "joinColumns" && x.args.name);
        return a.args.name && joins.length ? [[a.args.name, joins] as const] : [];
      }),
    );
  // @AssociationOverride(s) with a joinTable: the to-many attribute it names (a mapped
  // superclass's field) -> the @JoinTable that replaces the attribute's own.
  const joinTableOverrides = (t: { annotations: JavaAnnotation[] }) =>
    new Map(
      repeated(t, "AssociationOverride", "AssociationOverrides").flatMap((a) => {
        const jt = (a.nested ?? []).find((x) => x.element === "joinTable");
        return a.args.name && jt ? [[a.args.name, jt] as const] : [];
      }),
    );
  function parentEntity(t: JavaType) {
    const p = superOf(mappedSupers(t).at(-1) ?? t);
    return p && p !== t && ann(p, "Entity") ? p : undefined;
  }
  // The entity and its entity superclasses, the entity first (a cycle stops the walk).
  function entityChain(t: JavaType) {
    const chain = [t];
    for (let p = parentEntity(t); p && !chain.includes(p); p = parentEntity(p)) {
      chain.push(p);
    }
    return chain;
  }
  const rootEntity = (t: JavaType) => entityChain(t).at(-1) ?? t;
  const strategyOf = (root: JavaType) => {
    const s = ann(root, "Inheritance")?.args.strategy?.split(".").pop();
    return s === "JOINED" || s === "TABLE_PER_CLASS" ? s : "SINGLE_TABLE";
  };
  // The entity's @Id column (one field; an @EmbeddedId or @IdClass key is not one column); a
  // subclass inherits its superclass's.
  const idColumn = (t: JavaType, seen: JavaType[] = []): string | undefined => {
    const e = entityChain(t).find((x) => ownFields(x).some((f) => ann(f, "Id"))) ?? t;
    const ids = ownFields(e).filter((f) => ann(f, "Id"));
    if (ids.length !== 1) {
      return undefined;
    }
    // Derived identity: an @Id on a to-one is keyed by the relationship's join column.
    if (ann(ids[0], "ManyToOne", "OneToOne")) {
      return toOneKeyColumn(ids[0], e, seen);
    }
    const col = ann(ids[0], "Column")?.args.name;
    return (
      overrides(t).get(ids[0].name) ??
      mapsIdColumn(e, seen) ??
      (col ? canonical(col) : springName(ids[0].name))
    );
  };
  // An @Id mapped by a to-one @MapsId (no value) has the relationship's join column as its column.
  const mapsIdColumn = (e: JavaType, seen: JavaType[]) => {
    const f = ownFields(e).find(
      (x) => ann(x, "ManyToOne", "OneToOne") && ann(x, "MapsId") && !ann(x, "MapsId")?.args.value,
    );
    return f ? toOneKeyColumn(f, e, seen) : undefined;
  };
  // A to-one that is (@Id on it) or maps (@MapsId) the key: its single join column, @JoinColumn's
  // name, else JPA's default FIELD_ + the target's @Id column.
  const toOneKeyColumn = (f: JavaField, e: JavaType, seen: JavaType[]) => {
    const joins = repeated(f, "JoinColumn", "JoinColumns").filter((j) => j.args.name);
    if (joins.length === 1) {
      return canonical(joins[0].args.name);
    }
    if (joins.length > 1) {
      return undefined;
    }
    const written = ann(f, "ManyToOne", "OneToOne")?.args.targetEntity?.replace(/\.class$/, "");
    const target = resolveType(written ?? f.type, e);
    const pk = target && !seen.includes(target) ? idColumn(target, [...seen, e]) : undefined;
    return `${springName(f.name)}_${pk ?? "ID"}`;
  };
  // @ManyToOne / @OneToOne owning side: the target entity (targetEntity = X.class, else the field
  // type) and the join columns (@JoinColumn, or each one in @JoinColumns). Without a named join
  // column JPA's default applies: FIELD_ + the target's @Id column (ID when that is not known).
  function relation(
    t: JavaType,
    f: JavaField,
    rel: JavaAnnotation,
    table: string,
    schema: string | undefined,
    overridden?: JavaAnnotation[],
  ): JavaRelation {
    const written = rel.args.targetEntity?.replace(/\.class$/, "") ?? f.type;
    const target = resolveType(written, t);
    const mapped = target ? entityMapping(target) : undefined;
    const joins = overridden ?? repeated(f, "JoinColumn", "JoinColumns").filter((j) => j.args.name);
    const pk = target ? idColumn(target) : undefined;
    const refs = joins.map((j) => j.args.referencedColumnName).filter(Boolean);
    return {
      file: f.file,
      line: f.line,
      type: t.qualifiedName,
      field: f.name,
      kind: rel.name.split(".").pop() === "OneToOne" ? "OneToOne" : "ManyToOne",
      table,
      ...(schema ? { schema } : {}),
      columns: joins.length
        ? joins.map((j) => canonical(j.args.name))
        : [`${springName(f.name)}_${pk ?? "ID"}`],
      implicit: joins.length === 0,
      ...(refs.length === joins.length && refs.length > 0
        ? { referenced: refs.map(canonical) }
        : {}),
      ...(mapped
        ? { target: mapped.table, ...(mapped.schema ? { targetSchema: mapped.schema } : {}) }
        : { unresolved: written }),
    };
  }

  // @ManyToMany / @OneToMany owning side. The target is targetEntity or the collection's element
  // type (the last type argument). A @OneToMany with a join column joins from the target's table
  // to the owner's; otherwise the mapping has a join table (@JoinTable, else JPA's default
  // OWNER_TARGET) and is two joins: joinColumns to the owner (default: the inverse field, or the
  // owner's entity name, + _ + the owner's @Id column) and inverseJoinColumns to the target
  // (default: FIELD_ + the target's @Id column). An @AssociationOverride's joinTable replaces
  // the field's @JoinTable (and makes a join-column @OneToMany a join-table one). A join table's
  // join and inverse join columns (and a join-column @OneToMany's join columns, on the target's
  // table) are also listed as its columns.
  function toMany(
    t: JavaType,
    f: JavaField,
    rel: JavaAnnotation,
    table: string,
    schema: string | undefined,
    overridden?: JavaAnnotation,
  ): JavaRelation[] {
    const kind = rel.name.split(".").pop() === "OneToMany" ? "OneToMany" : "ManyToMany";
    const element = /<([^<>]*)>\s*$/.exec(f.type)?.[1].split(",").pop()?.trim();
    const written = rel.args.targetEntity?.replace(/\.class$/, "") ?? element ?? f.type;
    const target = resolveType(written, t);
    const mapped = target ? entityMapping(target) : undefined;
    const base = {
      file: f.file,
      line: f.line,
      type: t.qualifiedName,
      field: f.name,
      kind,
    } as const;
    const ownerPk = idColumn(t) ?? "ID";
    const targetPk = (target ? idColumn(target) : undefined) ?? "ID";
    const cols = (js: JavaAnnotation[], dflt: string) => {
      const named = js.filter((j) => j.args.name);
      const refs = named.map((j) => j.args.referencedColumnName).filter(Boolean);
      return {
        columns: named.length ? named.map((j) => canonical(j.args.name)) : [dflt],
        implicit: named.length === 0,
        ...(refs.length === named.length && refs.length > 0
          ? { referenced: refs.map(canonical) }
          : {}),
      };
    };
    const owner = { target: table, ...(schema ? { targetSchema: schema } : {}) };
    const other = mapped
      ? { target: mapped.table, ...(mapped.schema ? { targetSchema: mapped.schema } : {}) }
      : { unresolved: written };
    const joinCols = repeated(f, "JoinColumn", "JoinColumns");
    const jt = overridden ?? ann(f, "JoinTable");
    if (kind === "OneToMany" && joinCols.length > 0 && !jt) {
      if (!mapped) {
        return [];
      }
      const join: JavaRelation = {
        ...base,
        table: mapped.table,
        ...(mapped.schema ? { schema: mapped.schema } : {}),
        ...cols(joinCols, `${springName(f.name)}_${ownerPk}`),
        ...owner,
      };
      // The join columns are the target table's own columns too.
      for (const c of join.columns) {
        columns.push({
          file: f.file,
          line: f.line,
          type: t.qualifiedName,
          field: f.name,
          table: mapped.table,
          column: c,
          implicit: join.implicit,
        });
      }
      return [join, ...rowColumns(t, f, mapped.table, mapped.schema)];
    }
    const jname = jt?.args.name ?? jt?.args.value;
    const dotted = jname?.split(".");
    const jsname = jt?.args.schema || (dotted && dotted.length > 1 ? dotted.at(-2) : undefined);
    if (!jname && !mapped) {
      return [];
    }
    const jtable = jname ? canonical(jname) : `${table}_${mapped?.table}`;
    const jschema = jsname ? canonical(jsname) : undefined;
    const inner = (el: string) => (jt?.nested ?? []).filter((a) => a.element === el);
    const inverse = (target ? ownFields(target) : []).find(
      (x) => ann(x, "ManyToMany")?.args.mappedBy === f.name,
    );
    const ownerName = springName(inverse?.name ?? ann(t, "Entity")?.args.name ?? t.name);
    const at = { table: jtable, ...(jschema ? { schema: jschema } : {}), joinTable: true } as const;
    const joins: JavaRelation[] = [
      { ...base, ...at, ...cols(inner("joinColumns"), `${ownerName}_${ownerPk}`), ...owner },
      {
        ...base,
        ...at,
        ...cols(inner("inverseJoinColumns"), `${springName(f.name)}_${targetPk}`),
        ...other,
      },
    ];
    // The join table's join and inverse join columns are its own columns too.
    for (const j of joins) {
      for (const c of j.columns) {
        columns.push({
          file: f.file,
          line: f.line,
          type: t.qualifiedName,
          field: f.name,
          table: jtable,
          column: c,
          implicit: j.implicit,
        });
      }
    }
    return [...joins, ...rowColumns(t, f, jtable, jschema)];
  }

  // The key and order columns of a Map or @OrderColumn collection live on the table holding its
  // rows (collection table, join table, or a join-column @OneToMany's target table): an
  // entity-keyed map's @MapKeyJoinColumn(s) (a MapKey relation, returned), else @MapKeyColumn
  // (default FIELD_KEY); @OrderColumn defaults to FIELD_ORDER.
  function rowColumns(
    t: JavaType,
    f: JavaField,
    table: string,
    schema: string | undefined,
  ): JavaRelation[] {
    const column = (
      c: string | undefined,
      dflt: string,
      implicit = !c,
      stores?: JavaColumnMap["stores"],
    ) =>
      columns.push({
        file: f.file,
        line: f.line,
        type: t.qualifiedName,
        field: f.name,
        table,
        column: c ? canonical(c) : dflt,
        implicit,
        ...(stores ? { stores } : {}),
      });
    const key = mapKey(t, f, table, schema);
    if (key) {
      for (const c of key.columns) {
        column(c, c, key.implicit);
      }
    } else if (last(f.type).endsWith("Map")) {
      column(
        ann(f, "MapKeyColumn")?.args.name,
        `${springName(f.name)}_KEY`,
        undefined,
        keyStorage(t, f),
      );
    }
    const order = ann(f, "OrderColumn");
    if (order) {
      column(order.args.name, `${springName(f.name)}_ORDER`);
    }
    return key ? [key] : [];
  }

  // A basic Map key's storage: @MapKeyEnumerated (EnumType.STRING, else ORDINAL), JPA's ORDINAL
  // default for a key typed by one of the project's enums, or @MapKeyTemporal's TemporalType.
  function keyStorage(t: JavaType, f: JavaField): JavaColumnMap["stores"] {
    return storage(
      t,
      ann(f, "MapKeyEnumerated"),
      ann(f, "MapKeyTemporal"),
      ann(f, "MapKeyClass")?.args.value?.replace(/\.class$/, "") ??
        /<\s*([\w.]+)\s*,/.exec(f.type)?.[1],
    );
  }

  // How a basic column stores its value: the enumerated annotation (EnumType.STRING, else
  // ORDINAL), JPA's ORDINAL default for a value typed by one of the project's enums, or the
  // temporal annotation's TemporalType. `written` is the value's type as written.
  function storage(
    t: JavaType,
    enumerated: JavaAnnotation | undefined,
    temporal: JavaAnnotation | undefined,
    written: string | undefined,
  ): JavaColumnMap["stores"] {
    if (enumerated) {
      return (enumerated.args.value ?? "").endsWith("STRING") ? "STRING" : "ORDINAL";
    }
    const tt = /(TIMESTAMP|DATE|TIME)$/.exec(temporal?.args.value ?? "");
    if (tt) {
      return tt[1] as "TIMESTAMP" | "DATE" | "TIME";
    }
    return written && resolveType(written, t)?.kind === "enum" ? "ORDINAL" : undefined;
  }

  // A Map whose key is an entity (the first type argument, else @MapKeyClass) keys its rows by
  // @MapKeyJoinColumn(s) (default: FIELD_KEY) on the table holding the map's rows: a MapKey join
  // from that table to the key entity's, on the key entity's @Id column unless referenced.
  function mapKey(
    t: JavaType,
    f: JavaField,
    table: string,
    schema: string | undefined,
  ): JavaRelation | undefined {
    if (!last(f.type).endsWith("Map")) {
      return undefined;
    }
    const written =
      ann(f, "MapKeyClass")?.args.value?.replace(/\.class$/, "") ??
      /<\s*([\w.]+)\s*,/.exec(f.type)?.[1];
    const key = written ? resolveType(written, t) : undefined;
    const mapped = key ? entityMapping(key) : undefined;
    const joins = repeated(f, "MapKeyJoinColumn", "MapKeyJoinColumns").filter((j) => j.args.name);
    if (!mapped && joins.length === 0) {
      return undefined;
    }
    const refs = joins.map((j) => j.args.referencedColumnName).filter(Boolean);
    return {
      file: f.file,
      line: f.line,
      type: t.qualifiedName,
      field: f.name,
      kind: "MapKey",
      table,
      ...(schema ? { schema } : {}),
      columns: joins.length
        ? joins.map((j) => canonical(j.args.name))
        : [`${springName(f.name)}_KEY`],
      implicit: joins.length === 0,
      ...(refs.length === joins.length && refs.length > 0
        ? { referenced: refs.map(canonical) }
        : {}),
      ...(mapped
        ? { target: mapped.table, ...(mapped.schema ? { targetSchema: mapped.schema } : {}) }
        : { unresolved: written ?? f.type }),
    };
  }

  const supertypes: JavaSupertype[] = [];
  const hasSubclass = new Set(types.filter((t) => ann(t, "Entity")).map(parentEntity));
  // A hierarchy root's discriminator column: SINGLE_TABLE always has one (DTYPE by default),
  // JOINED only with @DiscriminatorColumn, TABLE_PER_CLASS never.
  const discriminatorOf = (root: JavaType, strategy: string) => {
    const disc = ann(root, "DiscriminatorColumn");
    if (
      strategy === "TABLE_PER_CLASS" ||
      !(disc || (strategy === "SINGLE_TABLE" && hasSubclass.has(root)))
    ) {
      return undefined;
    }
    return disc?.args.name ? canonical(disc.args.name) : "DTYPE";
  };
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
    const mapped = entity ? entityMapping(t) : undefined;
    if (entity && mapped) {
      const table = ann(t, "Table");
      const { table: canon, schema, named } = mapped;
      const ename = entity.args.name ?? t.name;
      entityTable.set(t.qualifiedName, canon);
      entityName.set(ename.toUpperCase(), canon);
      if (schema) {
        entitySchema.set(t.qualifiedName, schema);
      }
      const root = rootEntity(t);
      const strategy = strategyOf(root);
      const parent = parentEntity(t);
      const discColumn = discriminatorOf(root, strategy);
      const discValue = ann(t, "DiscriminatorValue");
      const discType = ann(root, "DiscriminatorColumn")?.args.discriminatorType?.split(".").pop();
      // An abstract entity has no rows of its own, so nothing marks them: no default value.
      const isAbstract = t.modifiers.includes("abstract");
      tableUses.push({
        file: (table ?? entity).file,
        line: (table ?? entity).line,
        type: t.qualifiedName,
        table: canon,
        ...(schema ? { schema } : {}),
        ops: [],
        kind: "entity",
        via:
          parent && strategy === "SINGLE_TABLE"
            ? `@Inheritance(SINGLE_TABLE) ${root.name}`
            : named
              ? "@Table"
              : "@Entity (default name)",
        ...(discColumn
          ? {
              discriminator: {
                root: root.qualifiedName,
                column: discColumn,
                ...(discValue?.args.value
                  ? { value: discValue.args.value }
                  : !isAbstract && (!discType || discType === "STRING")
                    ? { value: ename }
                    : {}),
                implicit: !discValue?.args.value,
                ...(isAbstract ? { abstract: true as const } : {}),
              },
            }
          : {}),
      });
      // The hierarchy root's table carries the discriminator column.
      const disc = ann(t, "DiscriminatorColumn");
      if (!parent && discColumn) {
        const at = disc ?? ann(t, "Inheritance") ?? entity;
        columns.push({
          file: at.file,
          line: at.line,
          type: t.qualifiedName,
          field: "",
          table: canon,
          column: discColumn,
          implicit: !disc?.args.name,
          discriminator: true,
        });
      }
      // A table joined to another on primary key join columns holds them as its own columns.
      const pkColumns = (join: JavaRelation, at: JavaAnnotation) => {
        for (const c of join.columns) {
          columns.push({
            file: at.file,
            line: at.line,
            type: t.qualifiedName,
            field: "",
            table: join.table,
            column: c,
            implicit: join.implicit,
            primaryKeyJoin: true,
          });
        }
      };
      // A JOINED subclass's table joins its superclass's on the primary key join columns
      // (@PrimaryKeyJoinColumn(s); default: the superclass's primary key column names).
      const pm = parent && strategy === "JOINED" ? entityMapping(parent) : undefined;
      if (parent && pm) {
        const pks = repeated(t, "PrimaryKeyJoinColumn", "PrimaryKeyJoinColumns").filter(
          (a) => a.args.name,
        );
        const refs = pks.map((a) => a.args.referencedColumnName).filter(Boolean);
        const at = ann(t, "PrimaryKeyJoinColumn", "PrimaryKeyJoinColumns") ?? table ?? entity;
        const join: JavaRelation = {
          file: at.file,
          line: at.line,
          type: t.qualifiedName,
          field: "",
          kind: "Inheritance",
          table: canon,
          ...(schema ? { schema } : {}),
          columns: pks.length ? pks.map((a) => canonical(a.args.name)) : [idColumn(parent) ?? "ID"],
          implicit: pks.length === 0,
          ...(refs.length === pks.length && refs.length > 0
            ? { referenced: refs.map(canonical) }
            : {}),
          target: pm.table,
          ...(pm.schema ? { targetSchema: pm.schema } : {}),
        };
        relations.push(join);
        // The primary key join columns are the subclass table's own columns too.
        pkColumns(join, at);
      }
      // @SecondaryTable (each one in @SecondaryTables): more of the entity's columns, in another
      // table joined to the primary one on its primary key join columns (default: the primary
      // table's @Id column name). A @Column / @JoinColumn with `table =` maps there.
      const secondary = repeated(t, "SecondaryTable", "SecondaryTables").flatMap((s) => {
        const sname = s.args.name ?? s.args.value;
        if (!sname) {
          return [];
        }
        const dotted = sname.split(".");
        const ss = s.args.schema || (dotted.length > 1 ? dotted.at(-2) : undefined);
        return [{ at: s, table: canonical(sname), schema: ss ? canonical(ss) : undefined }];
      });
      for (const s of secondary) {
        tableUses.push({
          file: s.at.file,
          line: s.at.line,
          type: t.qualifiedName,
          table: s.table,
          ...(s.schema ? { schema: s.schema } : {}),
          ops: [],
          kind: "entity",
          via: "@SecondaryTable",
        });
        const pks = (s.at.nested ?? []).filter((a) => a.element === "pkJoinColumns" && a.args.name);
        const refs = pks.map((a) => a.args.referencedColumnName).filter(Boolean);
        const join: JavaRelation = {
          file: s.at.file,
          line: s.at.line,
          type: t.qualifiedName,
          field: "",
          kind: "SecondaryTable",
          table: s.table,
          ...(s.schema ? { schema: s.schema } : {}),
          columns: pks.length ? pks.map((a) => canonical(a.args.name)) : [idColumn(t) ?? "ID"],
          implicit: pks.length === 0,
          ...(refs.length === pks.length && refs.length > 0
            ? { referenced: refs.map(canonical) }
            : {}),
          target: canon,
          ...(schema ? { targetSchema: schema } : {}),
        };
        relations.push(join);
        // The primary key join columns are the secondary table's own columns too.
        pkColumns(join, s.at);
      }
      // The table a column annotation's `table =` names: a secondary table, else the primary.
      const tableOf = (a?: JavaAnnotation) => {
        const named = a?.args.table ? canonical(a.args.table) : undefined;
        const s = named ? secondary.find((x) => x.table === named) : undefined;
        return s ?? { table: named ?? canon, schema: named ? undefined : schema };
      };
      // The entity's fields and its mapped superclasses'; a TABLE_PER_CLASS subclass's table
      // holds its entity superclasses' columns too.
      const fields =
        strategy === "TABLE_PER_CLASS"
          ? entityChain(t).toReversed().flatMap(ownFields)
          : ownFields(t);
      const renamed = overrides(t);
      const rejoined = joinOverrides(t);
      const retabled = joinTableOverrides(t);
      // @MapsId on a to-one: the relationship's join columns also map the entity's @Id (no value;
      // the whole @EmbeddedId if that is the key) or one @EmbeddedId attribute (value). That id
      // attribute has no column of its own; its path is recorded on the join columns.
      const idField = fields.find((f) => ann(f, "Id"));
      const embeddedId = fields.find((f) => ann(f, "EmbeddedId"));
      const derived = new Map<string, string>();
      for (const f of fields) {
        const m = ann(f, "MapsId");
        if (!m || !ann(f, "ManyToOne", "OneToOne")) {
          continue;
        }
        const id = m.args.value
          ? embeddedId && `${embeddedId.name}.${m.args.value}`
          : (idField ?? embeddedId)?.name;
        if (id) {
          derived.set(f.name, id);
        }
      }
      const mappedIds = new Set(derived.values());
      const isMappedId = (path: string) =>
        [...mappedIds].some((id) => path === id || path.startsWith(`${id}.`));
      // `prefix` is the path of the embedded field the list belongs to ("" for the entity's own).
      // `into` is the collection table an element collection's embeddable maps on.
      const mapFields = (
        owner: JavaType,
        list: JavaField[],
        prefix: string,
        seen: JavaType[],
        into?: { table: string; schema?: string },
      ) => {
        for (const f of list) {
          if (
            f.modifiers.includes("static") ||
            f.modifiers.includes("transient") ||
            ann(f, "Transient")
          ) {
            continue;
          }
          const path = prefix + f.name;
          if (isMappedId(path) && !ann(f, "ManyToOne", "OneToOne")) {
            continue;
          }
          const ec = ann(f, "ElementCollection");
          if (ec) {
            // Like a to-many collection, one inside an embeddable is not modelled.
            if (!prefix) {
              elementCollection(f, ec);
            }
            continue;
          }
          const many = ann(f, "OneToMany", "ManyToMany");
          if (many) {
            // A collection has no column on the entity's table; the inverse side (`mappedBy`) is
            // mapped by the target's owning field. Collections inside an embeddable are not modelled.
            if (!many.args.mappedBy && !prefix) {
              relations.push(...toMany(t, f, many, canon, schema, retabled.get(path)));
            }
            continue;
          }
          const rel = ann(f, "ManyToOne", "OneToOne");
          if (rel) {
            // The owning side of a to-one relationship: its join columns are the table's columns.
            // The inverse side (`mappedBy`) has no column of its own.
            // An @AssociationOverride for this path replaces the field's join columns.
            const over = rejoined.get(path);
            const joins = over ?? repeated(f, "JoinColumn", "JoinColumns");
            const on = into ?? tableOf(joins.find((j) => j.args.table));
            const r = rel.args.mappedBy
              ? undefined
              : relation(t, f, rel, on.table, on.schema, over);
            if (r) {
              relations.push({ ...r, field: path });
              for (const c of r.columns) {
                columns.push({
                  file: f.file,
                  line: f.line,
                  type: t.qualifiedName,
                  field: path,
                  table: r.table,
                  column: c,
                  implicit: r.implicit,
                  ...(!prefix && derived.has(f.name) ? { mapsId: derived.get(f.name) } : {}),
                });
              }
            }
            continue;
          }
          // An embedded field (@Embedded, @EmbeddedId, or a field whose type is @Embeddable) has
          // no column of its own: the embeddable's fields map on this table as path.attr, renamed
          // by @AttributeOverride(s) on the field or, by that path, on the entity (the outermost
          // override wins). Nested embeddables recurse; a cycle stops.
          const e = resolveType(f.type, owner);
          if (e && (ann(e, "Embeddable") || ann(f, "Embedded", "EmbeddedId"))) {
            if (!seen.includes(e)) {
              for (const [attr, col] of overrides(f)) {
                if (!renamed.has(`${path}.${attr}`)) {
                  renamed.set(`${path}.${attr}`, col);
                }
              }
              for (const [attr, joins] of joinOverrides(f)) {
                if (!rejoined.has(`${path}.${attr}`)) {
                  rejoined.set(`${path}.${attr}`, joins);
                }
              }
              mapFields(e, e.fields, `${path}.`, [...seen, e], into);
            }
            continue;
          }
          const col = ann(f, "Column", "JoinColumn");
          const cname = col?.args.name;
          const over = renamed.get(path);
          const stores = storage(owner, ann(f, "Enumerated"), ann(f, "Temporal"), f.type);
          columns.push({
            file: f.file,
            line: f.line,
            type: t.qualifiedName,
            field: path,
            table: into?.table ?? tableOf(col).table,
            column: over ?? (cname ? canonical(cname) : springName(f.name)),
            implicit: !over && !cname,
            ...(stores ? { stores } : {}),
          });
        }
      };
      // @ElementCollection: the values live in a collection table (@CollectionTable, else JPA's
      // default ENTITY_FIELD) joined to the entity's table on its join columns (default: the
      // entity name + _ + the entity's @Id column). A basic element is one column (@Column, else
      // the field name); an @Embeddable element's fields map there by path, renamed by the field's
      // @AttributeOverride(s). The join columns are listed as the collection table's columns too.
      // Map key and order columns are rowColumns'.
      function elementCollection(f: JavaField, ec: JavaAnnotation) {
        const ct = ann(f, "CollectionTable");
        const cname = ct?.args.name ?? ct?.args.value;
        const dotted = cname?.split(".");
        const cs = ct?.args.schema || (dotted && dotted.length > 1 ? dotted.at(-2) : undefined);
        const into = {
          table: cname ? canonical(cname) : `${springName(ename)}_${springName(f.name)}`,
          ...(cs ? { schema: canonical(cs) } : {}),
        };
        const at = ct ?? ec;
        tableUses.push({
          file: at.file,
          line: at.line,
          type: t.qualifiedName,
          ...into,
          ops: [],
          kind: "entity",
          via: ct && cname ? "@CollectionTable" : "@ElementCollection (default name)",
        });
        const joins = (ct?.nested ?? []).filter((a) => a.element === "joinColumns" && a.args.name);
        const refs = joins.map((a) => a.args.referencedColumnName).filter(Boolean);
        const join: JavaRelation = {
          file: f.file,
          line: f.line,
          type: t.qualifiedName,
          field: f.name,
          kind: "ElementCollection",
          ...into,
          columns: joins.length
            ? joins.map((a) => canonical(a.args.name))
            : [`${springName(ename)}_${idColumn(t) ?? "ID"}`],
          implicit: joins.length === 0,
          ...(refs.length === joins.length && refs.length > 0
            ? { referenced: refs.map(canonical) }
            : {}),
          target: canon,
          ...(schema ? { targetSchema: schema } : {}),
        };
        relations.push(join);
        // The join columns are the collection table's own columns too.
        for (const c of join.columns) {
          columns.push({
            file: f.file,
            line: f.line,
            type: t.qualifiedName,
            field: f.name,
            table: into.table,
            column: c,
            implicit: join.implicit,
          });
        }
        relations.push(...rowColumns(t, f, into.table, into.schema));
        const element = /<([^<>]*)>\s*$/.exec(f.type)?.[1].split(",").pop()?.trim();
        const written = ec.args.targetClass?.replace(/\.class$/, "") ?? element;
        const e = written ? resolveType(written, t) : undefined;
        if (e && ann(e, "Embeddable")) {
          for (const [attr, col] of overrides(f)) {
            renamed.set(`${f.name}.${attr}`, col);
          }
          for (const [attr, joins] of joinOverrides(f)) {
            rejoined.set(`${f.name}.${attr}`, joins);
          }
          mapFields(e, e.fields, `${f.name}.`, [e], into);
        } else {
          // @Enumerated / @Temporal on the collection field apply to its basic element.
          const c = ann(f, "Column")?.args.name;
          const stores = storage(t, ann(f, "Enumerated"), ann(f, "Temporal"), written);
          columns.push({
            file: f.file,
            line: f.line,
            type: t.qualifiedName,
            field: f.name,
            table: into.table,
            column: c ? canonical(c) : springName(f.name),
            implicit: !c,
            ...(stores ? { stores } : {}),
          });
        }
      }
      mapFields(t, fields, "", []);
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
  const schemaOf = (e: JavaType | undefined) => {
    const schema = e ? entitySchema.get(e.qualifiedName) : undefined;
    return schema ? { schema } : {};
  };
  for (const [repo, e] of repoEntity) {
    const t = byQn.get(repo) as JavaType;
    const table = tableOfEntity(e);
    if (table) {
      tableUses.push({
        file: t.file,
        line: t.line,
        type: repo,
        table,
        ...schemaOf(e),
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
    schemas: Map<string, string> = tableSchemas(s.text),
  ) => {
    for (const table of tables) {
      const schema = schemas.get(table);
      access(t, m, {
        file: s.file,
        line: s.line,
        table,
        ...(schema ? { schema } : {}),
        ops: opsOfSql(s.op),
        via,
        sqlOp: s.op,
        text: s.text,
        ...(s.partial ? { partial: true } : {}),
        ...(s.declaredAt ? { declaredAt: s.declaredAt } : {}),
      });
    }
  };

  // Stored-routine calls: an edge from the calling type (and method) to the routine, never a
  // table access of its own; the routine's body carries the access when the DDL defines it.
  const routineCalls: JavaRoutineCall[] = [];
  const callRoutine = (
    t: JavaType,
    m: JavaMethod | undefined,
    at: Loc,
    routine: string[],
    via: string,
    declaredAt?: Loc,
  ) =>
    routineCalls.push({
      file: at.file,
      line: at.line,
      type: t.qualifiedName,
      ...(m ? { method: m.signature } : {}),
      routine,
      via,
      ...(declaredAt ? { declaredAt } : {}),
    });
  // @NamedStoredProcedureQuery(name, procedureName) declares a routine under a JPA name; the
  // declaration itself is a call fact of its type, and @Procedure(name = ...) resolves through it.
  // A type may repeat it or list several inside @NamedStoredProcedureQueries({ ... }).
  const namedProcedures = new Map<string, { routine: string[]; at: Loc }>();
  for (const t of types) {
    for (const np of repeated(t, "NamedStoredProcedureQuery", "NamedStoredProcedureQueries")) {
      const routine = np.args.procedureName
        ? routineCall(`CALL ${np.args.procedureName}`)
        : undefined;
      if (routine) {
        if (np.args.name) {
          namedProcedures.set(np.args.name, { routine, at: { file: np.file, line: np.line } });
        }
        callRoutine(
          t,
          undefined,
          np,
          routine,
          `@NamedStoredProcedureQuery ${np.args.name ?? ""}`.trim(),
        );
      }
    }
  }

  // Repository methods first (derived queries and @Query), so callers can inherit their access.
  const methodAccess = new Map<string, JavaTableUse[]>();
  for (const t of types) {
    const e = repoEntity.get(t.qualifiedName);
    for (const m of t.methods) {
      const before = tableUses.length;
      const query = ann(m, "Query");
      const procedure = ann(m, "Procedure");
      if (procedure) {
        // Spring Data: procedureName / value name the routine, name a @NamedStoredProcedureQuery;
        // with neither, the method name is the routine's name.
        const a = procedure.args;
        const named = a.name ? namedProcedures.get(a.name) : undefined;
        const written = a.procedureName ?? a.value;
        // A name with no @NamedStoredProcedureQuery in the sources stays a call to that name, and
        // says so, rather than being dropped.
        const routine =
          (written ? routineCall(`CALL ${written}`) : named?.routine) ??
          (a.name ? [a.name.toUpperCase()] : [canonical(m.name)]);
        callRoutine(
          t,
          m,
          procedure,
          routine,
          written
            ? "@Procedure"
            : named
              ? `@Procedure(name = ${a.name})`
              : a.name
                ? `@Procedure(name = ${a.name}): no @NamedStoredProcedureQuery of that name in the sources`
                : "@Procedure (method name)",
          named?.at,
        );
      } else if (query) {
        const text = query.args.value ?? "";
        const native = query.args.nativeQuery === "true";
        const sql = sqlTables(text);
        const called = native ? routineCall(text) : undefined;
        if (called) {
          callRoutine(t, m, query, called, "@Query native CALL");
        }
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
        // JPQL names entities, so a table's schema is its entity's @Table schema; two entities
        // of one table with different schemas leave it unknown.
        const jpqlSchemas = new Map<string, string>();
        for (const [qn, schema] of native ? [] : entitySchema) {
          const tn = entityTable.get(qn) as string;
          jpqlSchemas.set(tn, jpqlSchemas.has(tn) && jpqlSchemas.get(tn) !== schema ? "" : schema);
        }
        sqlAccess(
          t,
          m,
          use,
          tables,
          `@Query ${native ? "native " : ""}${sql.op}`,
          native ? undefined : jpqlSchemas,
        );
      } else if (e && tableOfEntity(e)) {
        const ops = derivedOps(m.name);
        if (ops) {
          access(t, m, {
            file: m.file,
            line: m.line,
            table: tableOfEntity(e) as string,
            ...schemaOf(e),
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

  // MyBatis mapper statements belong to the method of the same name of the namespace interface,
  // so callers of the mapper inherit their access like a repository's.
  const mybatisUnbound: Array<Loc & { namespace: string; id: string }> = [];
  for (const mp of mappers) {
    const t = byQn.get(mp.namespace);
    for (const st of mp.statements) {
      const m = t?.methods.find((x) => x.name === st.id);
      if (!t || !m) {
        mybatisUnbound.push({ file: st.file, line: st.line, namespace: mp.namespace, id: st.id });
        if (!t) {
          continue;
        }
      }
      const sql = sqlTables(st.text);
      const before = tableUses.length;
      const use: SqlUse = {
        file: st.file,
        line: st.line,
        text: st.text,
        op: sql.op,
        tables: sql.tables,
        via: "mybatis",
        ...(st.partial ? { partial: true } : {}),
      };
      sqlAccess(t, m, use, sql.tables, `MyBatis <${st.kind} id="${st.id}"> ${sql.op}`);
      const called = routineCall(st.text);
      if (called) {
        callRoutine(t, m, st, called, `MyBatis <${st.kind} id="${st.id}"> CALL`);
      }
      if (m && tableUses.length > before) {
        const id = methodId(t.qualifiedName, m);
        methodAccess.set(id, [...(methodAccess.get(id) ?? []), ...tableUses.slice(before)]);
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
              ...(u.schema ? { schema: u.schema } : {}),
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
              ...schemaOf(e),
              ops: INHERITED[c.name],
              via: `${repoT.name}.${c.name} (inherited)`,
            });
          }
        }
      }
      for (const s of m.sql) {
        sqlAccess(t, m, s, s.tables, `JDBC ${s.op}`);
        const called = routineCall(s.text);
        if (called) {
          callRoutine(
            t,
            m,
            s,
            called,
            s.via === "call" ? "createStoredProcedureQuery" : "JDBC CALL",
          );
        }
      }
      for (const r of m.refs) {
        const f = constants.get(r.name);
        const called = f?.stringValue !== undefined ? routineCall(f.stringValue) : undefined;
        if (f && called) {
          usedConstants.add(f.name);
          callRoutine(t, m, r, called, `JDBC CALL (constant ${f.name})`, {
            file: f.file,
            line: f.line,
          });
        }
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
      const called = routineCall(f.stringValue);
      if (called) {
        callRoutine(t, undefined, f, called, `CALL constant ${f.name} (no method reference found)`);
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
  // Two entities of one hierarchy with the same discriminator value: the provider cannot tell
  // their rows apart.
  const discKey = (u: JavaTableUse) =>
    u.discriminator?.value === undefined || u.discriminator.abstract
      ? undefined
      : `${u.discriminator.root}\0${u.discriminator.value}`;
  const discCount = new Map<string, number>();
  for (const key of tableUses.map(discKey)) {
    if (key !== undefined) {
      discCount.set(key, (discCount.get(key) ?? 0) + 1);
    }
  }
  for (const u of tableUses) {
    const key = discKey(u);
    if (u.discriminator && key !== undefined && (discCount.get(key) ?? 0) > 1) {
      u.discriminator.duplicate = true;
    }
  }
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
    ...(mybatisUnbound.length > 0 ? { mybatisUnbound: mybatisUnbound.toSorted(byLoc) } : {}),
    ...(routineCalls.length > 0 ? { routineCalls: routineCalls.toSorted(byLoc) } : {}),
    ...(relations.length > 0 ? { relations: relations.toSorted(byLoc) } : {}),
  };
}
