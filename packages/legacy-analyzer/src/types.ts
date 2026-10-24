// Fact model of the legacy analyser. Every fact carries the file and 1-based line it was read
// from, so an agent can cite it and a reviewer can check it against the source.

export type Loc = { file: string; line: number };

export type Diagnostic = Loc & { severity: "info" | "warning" | "error"; message: string };

export type TokenKind = "word" | "num" | "str" | "op" | "period" | "pseudo";

export type Token = {
  kind: TokenKind;
  /** Upper-cased for words; the literal's content for strings; the text otherwise. */
  value: string;
  /** Text as written. */
  raw: string;
  file: string;
  line: number;
  /** 1-based source column (fixed format: 8 = Area A start). */
  col: number;
};

export type DataItem = Loc & {
  level: number;
  name: string;
  /** Qualified path from the 01 level, e.g. ["EMP-RECORD", "EMP-TYPE"]. */
  path: string[];
  section: string;
  parent?: string;
  pic?: string;
  usage?: string;
  value?: string[];
  valueThru?: string;
  redefines?: string;
  occurs?: { min: number; max: number; dependingOn?: string };
  /** Bytes of one occurrence; undefined when it cannot be computed (unknown PIC, 66 level). */
  length?: number;
  /** 0-based byte offset from the start of the 01 record. */
  offset?: number;
  numeric?: { digits: number; scale: number; signed: boolean };
  /** Condition-name (88) values. */
  conditionValues?: string[];
  description?: string;
  copybook?: string;
  endLine?: number;
  text: string;
};

export type FileDef = Loc & {
  name: string;
  assign?: string;
  organization?: string;
  access?: string;
  status?: string;
  fdLine?: number;
  fdFile?: string;
  records: string[];
};

export type IoOp = "OPEN" | "READ" | "WRITE" | "REWRITE" | "DELETE" | "START" | "CLOSE";

export type Statement = Loc & {
  verb: string;
  endLine: number;
  /** Exact program text of the statement's source lines. */
  text: string;
  /** The statement's own tokens, joined (other statements on the same line excluded). */
  code: string;
  /** Literals in the statement: numeric, alphanumeric and figurative constants. */
  literals: string[];
  sets: string[];
  uses: string[];
  /** Enclosing IF/WHEN conditions, outermost first. */
  guards: string[];
  rounded?: boolean;
  performs?: { target: string; thru?: string; until?: string; varying?: string; inline: boolean };
  call?: { target: string; dynamic: boolean; using: string[] };
  io?: { op: IoOp; file: string; mode?: string; record?: string };
  condition?: string;
  sql?: { tables: string[]; ops: string[]; hostVars: string[] };
  goTo?: string[];
};

export type Paragraph = Loc & {
  name: string;
  section?: string;
  endLine: number;
  statements: Statement[];
};

export type CopyUse = Loc & {
  name: string;
  resolved?: string;
  replacing: Array<{ from: string; to: string }>;
};

export type Program = Loc & {
  name: string;
  divisions: Array<Loc & { name: string }>;
  sections: Array<Loc & { name: string; division: string }>;
  usingParams: string[];
  paragraphs: Paragraph[];
  dataItems: DataItem[];
  files: FileDef[];
  copies: CopyUse[];
};

export type DdStatement = Loc & {
  ddname: string;
  dsn?: string;
  dsnRaw?: string;
  disp?: string;
  sysout?: string;
  instream?: boolean;
  dummy?: boolean;
  /** From DISP: SHR = input, NEW/MOD = output, OLD = exclusive (read or rewrite). */
  access: "input" | "output" | "exclusive" | "sysout" | "instream" | "unknown";
};

export type JobStep = Loc & {
  name: string;
  program?: string;
  proc?: string;
  parm?: string;
  cond?: string;
  dds: DdStatement[];
  /** Steps of an expanded procedure, when `proc` is known. */
  procSteps?: JobStep[];
};

export type Job = Loc & {
  name: string;
  kind: "JOB" | "PROC";
  symbols: Record<string, string>;
  steps: JobStep[];
};

export type SourceFile = {
  path: string;
  kind: "cobol" | "copybook" | "jcl";
  sha256: string;
  lines: number;
  size: number;
  mtimeMs: number;
};

export type LegacyIndex = {
  schema: "kurahi.legacy-index/1";
  root: string;
  files: SourceFile[];
  programs: Program[];
  copybooks: Array<{ name: string; file: string; usedBy: Array<Loc & { program: string }> }>;
  jobs: Job[];
  diagnostics: Diagnostic[];
};
