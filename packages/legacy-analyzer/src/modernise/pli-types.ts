// Fact model of the PL/I engine. Every fact carries the file (root-relative, POSIX) and the 1-based
// line it was read from. Macro (%) statements other than %INCLUDE are gaps: they are reported,
// never evaluated, so the code of every %IF branch is read as written.

import type { Loc } from "../types.js";
import type { EngineGap } from "./types.js";

/** One DECLARE item: a scalar, a structure or a structure member. */
export type PliDecl = Loc & {
  level: number;
  name: string;
  /** Names from the level-1 item down to this one. */
  path: string[];
  /** Data attributes as written, normalised: `FIXED DEC(11,2)`, `CHAR(10)`, `PIC'99999999'`. */
  type?: string;
  dims?: string;
  /** Storage class and overlay: AUTOMATIC, STATIC, CONTROLLED, BASED(P), DEFINED(X), EXTERNAL. */
  storage: string[];
  init?: string;
  /** Include file the declaration came from. */
  via?: string;
};

export type PliFileDecl = Loc & {
  name: string;
  /** RECORD, STREAM, INPUT, OUTPUT, UPDATE, PRINT, SEQUENTIAL, DIRECT, KEYED, ENV(...). */
  attrs: string[];
  title?: string;
};

export type PliIo = Loc & {
  verb: "OPEN" | "CLOSE" | "READ" | "WRITE" | "REWRITE" | "DELETE" | "LOCATE" | "GET" | "PUT";
  /** The FILE constant (SYSIN / SYSPRINT for GET / PUT without FILE). */
  fileName: string;
  /** INTO / FROM / SET variable. */
  data?: string;
  /** OPEN: INPUT, OUTPUT, UPDATE; TITLE literal. */
  mode?: string;
  title?: string;
};

export type PliSql = Loc & {
  text: string;
  op: string;
  tables: string[];
  cursor?: string;
};

export type PliOnUnit = Loc & {
  condition: string;
  /** ENDFILE(RATEIN): the file or condition argument. */
  target?: string;
  action: string;
};

export type PliCall = Loc & { name: string; args: number };

export type PliProc = Loc & {
  name: string;
  /** MAIN.INNER for an internal procedure. */
  qualified: string;
  parent?: string;
  main: boolean;
  options?: string;
  params: string[];
  returns?: string;
  recursive: boolean;
  endLine: number;
  doc?: string;
  decls: PliDecl[];
  files: PliFileDecl[];
  entries: Array<Loc & { name: string; external: boolean }>;
  includes: Array<Loc & { name: string }>;
  calls: PliCall[];
  io: PliIo[];
  sql: PliSql[];
  onUnits: PliOnUnit[];
};

export type PliFile = {
  path: string;
  procs: PliProc[];
  /** Declarations outside any procedure: an include member. */
  fragment?: PliDecl[];
  statements: number;
  /** Columns 73-80 (sequence numbers) and column 1 were ignored. */
  margins: boolean;
  gaps: EngineGap[];
};
