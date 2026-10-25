// Fact model of the Java and SQL DDL engines. As in the COBOL index, every fact carries the file
// (root-relative, POSIX) and the 1-based line it was read from. Gaps are constructs the engines
// saw but did not model; they are reported, never guessed at.

import type { Loc } from "../types.js";

export type EngineGap = Loc & { construct: string; detail: string };

// ---------------------------------------------------------------- Java

export type JavaAnnotation = Loc & {
  /** Simple or qualified name as written, without `@`. */
  name: string;
  /** Element values as source text; a single unnamed value is `value`. String literals unquoted. */
  args: Record<string, string>;
  /** Annotations written inside the element values (`@Container({ @Item(..), @Item(..) })`). */
  nested?: JavaAnnotation[];
  /** For a nested annotation: the named element it is the value of (`joinColumns`). */
  element?: string;
};

export type JavaParam = { type: string; name: string };

export type JavaCall = Loc & {
  name: string;
  /** Receiver text as written (`this`, `super`, `repo`, `com.x.Util`), absent for a bare call. */
  qualifier?: string;
  /** Argument count at the call site. */
  args: number;
  /** `new` for constructor calls, `ref` for method references (`Type::name`). */
  form: "call" | "new" | "ref";
};

export type SqlUse = Loc & {
  /** SQL text, adjacent literals joined. */
  text: string;
  /** First keyword: SELECT, INSERT, UPDATE, DELETE, MERGE, ... */
  op: string;
  tables: string[];
  /**
   * jdbc: string literal in code; jpql / native: @Query; constant: a static String field;
   * mybatis: a statement of a MyBatis mapper XML; call: a stored-procedure API naming the routine
   * (`createStoredProcedureQuery("NAME")`), its text written as `CALL NAME`.
   */
  via: "jdbc" | "jpql" | "native" | "constant" | "mybatis" | "call";
  /** The literal is concatenated with non-literal values: only the literal parts were read. */
  partial?: boolean;
  /** Where the constant was declared, when `via` is constant. */
  declaredAt?: Loc;
};

export type JavaMethod = Loc & {
  name: string;
  kind: "method" | "constructor";
  returnType?: string;
  params: JavaParam[];
  modifiers: string[];
  annotations: JavaAnnotation[];
  throws: string[];
  /** `name(Type1, Type2)`: the method's identity inside its type. */
  signature: string;
  endLine: number;
  abstract: boolean;
  calls: JavaCall[];
  sql: SqlUse[];
  /** Identifiers referenced in the body (for constants holding SQL). */
  refs: Array<Loc & { name: string }>;
  doc?: string;
};

export type JavaField = Loc & {
  name: string;
  type: string;
  modifiers: string[];
  annotations: JavaAnnotation[];
  /** The initializer when it is only string literals (adjacent `+` joined). */
  stringValue?: string;
};

export type JavaTypeKind = "class" | "interface" | "enum" | "record" | "annotation";

export type JavaType = Loc & {
  name: string;
  /** package.Outer.Name */
  qualifiedName: string;
  kind: JavaTypeKind;
  package?: string;
  outer?: string;
  modifiers: string[];
  annotations: JavaAnnotation[];
  typeParams?: string;
  extends: string[];
  implements: string[];
  fields: JavaField[];
  methods: JavaMethod[];
  enumConstants: Array<Loc & { name: string }>;
  recordComponents: JavaParam[];
  endLine: number;
  doc?: string;
};

export type JavaImport = Loc & { name: string; static: boolean; wildcard: boolean };

export type JavaFile = {
  path: string;
  package?: string;
  imports: JavaImport[];
  types: JavaType[];
  gaps: EngineGap[];
};

// ---------------------------------------------------------------- SQL DDL

export type SqlColumn = Loc & {
  name: string;
  type: string;
  /** false: NOT NULL; true: NULL written; undefined: not stated. */
  nullable?: boolean;
  default?: string;
  primaryKey?: boolean;
  unique?: boolean;
  /** `schema`: the schema the reference names, when it is qualified. */
  references?: { table: string; column?: string; schema?: string };
  /** COMMENT ON COLUMN / LABEL ON / inline COMMENT '...' / trailing `--` remark. */
  comment?: string;
  commentAt?: Loc;
};

export type SqlConstraint = Loc & {
  kind: "PRIMARY KEY" | "FOREIGN KEY" | "UNIQUE" | "CHECK";
  name?: string;
  columns: string[];
  /** `schema`: the schema the reference names, when it is qualified. */
  references?: { table: string; columns: string[]; schema?: string };
  /** CHECK text. */
  text?: string;
};

export type SqlTable = Loc & {
  /** Canonical name: unquoted, upper case, without schema. */
  name: string;
  schema?: string;
  /** Name as written. */
  rawName: string;
  kind: "table" | "view";
  columns: SqlColumn[];
  constraints: SqlConstraint[];
  comment?: string;
  commentAt?: Loc;
  /** Views: the tables the defining query reads. */
  sources: string[];
  /** Views: the schema a source is named with, when every reference to it names the same one. */
  sourceSchemas?: Record<string, string>;
  endLine: number;
};

export type SqlIndex = Loc & {
  name: string;
  table: string;
  /** The schema the ON clause names, when it is qualified. */
  tableSchema?: string;
  columns: string[];
  unique: boolean;
};

export type SqlFile = { path: string; statements: number; gaps: EngineGap[] };

/** A stored routine whose body was read (DB2 SQL PL, Oracle PL/SQL, T-SQL BEGIN ... END). */
export type SqlRoutine = Loc & {
  kind: "PROCEDURE" | "FUNCTION" | "TRIGGER";
  /** Canonical name: unquoted, upper case, without schema. */
  name: string;
  schema?: string;
  rawName: string;
  endLine: number;
  /** PL/SQL package members: the package (the name is then PACKAGE.MEMBER). */
  package?: string;
  /** Triggers: the table they fire on and the events (INSERT, UPDATE, DELETE). */
  on?: string;
  events?: string[];
  /** Each table a static statement of the body names, with its verb (SELECT for a source). */
  access: Array<Loc & { table: string; schema?: string; op: string }>;
  /**
   * CALL statements of the body. The name is PACKAGE.MEMBER when the callee is a package member
   * (written `pkg.member`, or bare inside the same package); `qualifier` is the written prefix.
   */
  calls: Array<Loc & { name: string; qualifier?: string }>;
};

export type SqlModel = {
  files: SqlFile[];
  tables: SqlTable[];
  indexes: SqlIndex[];
  /** Routines with a read body, sorted by name; the first definition of a name wins. */
  routines: SqlRoutine[];
  /** Same table defined twice: the first definition wins; the others are listed here. */
  duplicates: Array<Loc & { name: string; first: Loc }>;
  /**
   * Bare names more than one explicit schema defines (`HR.EMPLOYEE`, `PAYROLL.EMPLOYEE`), sorted.
   * Tables join by bare name across languages, so a reference to one of these may mean either.
   */
  ambiguous: Array<{ name: string; schemas: string[] }>;
  /**
   * For each ambiguous name, every schema's own definition (one per schema, the first wins),
   * sorted by `SCHEMA.NAME`. The graph gives each a `table:SCHEMA.NAME` node.
   */
  schemaTables: SqlTable[];
};

export type JavaModel = {
  files: JavaFile[];
  /** All types, nested ones included, sorted by qualified name. */
  types: JavaType[];
};
