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
  /** jdbc: string literal in code; jpql / native: @Query; constant: a static String field. */
  via: "jdbc" | "jpql" | "native" | "constant";
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
  references?: { table: string; column?: string };
  /** COMMENT ON COLUMN / LABEL ON / inline COMMENT '...' / trailing `--` remark. */
  comment?: string;
  commentAt?: Loc;
};

export type SqlConstraint = Loc & {
  kind: "PRIMARY KEY" | "FOREIGN KEY" | "UNIQUE" | "CHECK";
  name?: string;
  columns: string[];
  references?: { table: string; columns: string[] };
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
  endLine: number;
};

export type SqlIndex = Loc & {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
};

export type SqlFile = { path: string; statements: number; gaps: EngineGap[] };

export type SqlModel = {
  files: SqlFile[];
  tables: SqlTable[];
  indexes: SqlIndex[];
  /** Same table defined twice: the first definition wins; the others are listed here. */
  duplicates: Array<Loc & { name: string; first: Loc }>;
};

export type JavaModel = {
  files: JavaFile[];
  /** All types, nested ones included, sorted by qualified name. */
  types: JavaType[];
};
