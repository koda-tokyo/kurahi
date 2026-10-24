// Fact model of the FORTRAN engine (fixed form FORTRAN 77 and free form Fortran 90 and later).
// As everywhere in the analyser, every fact carries the file (root-relative, POSIX) and the
// 1-based line it was read from. Constructs the engine sees but does not model are gaps.

import type { Loc } from "../types.js";
import type { EngineGap } from "./types.js";

export type FortranUnitKind = "program" | "subroutine" | "function" | "module" | "block-data";

/** A declared entity: `REAL*8 T(1000)` gives { name: "T", type: "REAL*8", dims: "1000" }. */
export type FortranDecl = Loc & {
  name: string;
  type: string;
  dims?: string;
  /** PARAMETER, ALLOCATABLE, INTENT(IN), SAVE, ... as written (upper case). */
  attrs: string[];
  /** Initial or PARAMETER value as written. */
  value?: string;
};

export type FortranCommon = Loc & {
  /** Block name, upper case; blank COMMON is "//". */
  block: string;
  members: Array<{ name: string; dims?: string }>;
};

export type FortranIo = Loc & {
  op:
    | "OPEN"
    | "CLOSE"
    | "READ"
    | "WRITE"
    | "PRINT"
    | "REWIND"
    | "BACKSPACE"
    | "ENDFILE"
    | "INQUIRE";
  /** Unit as written: a number, `*`, a name (variable or PARAMETER), or NEWUNIT=name. */
  unit?: string;
  /** FILE= literal (OPEN / INQUIRE). */
  fileName?: string;
  /** FILE= given by a variable or expression: the text. */
  fileExpr?: string;
  status?: string;
  action?: string;
  access?: string;
  form?: string;
  newunit?: boolean;
};

export type FortranCallSite = Loc & {
  name: string;
  args: number;
  form: "call" | "function";
};

export type FortranUnit = Loc & {
  name: string;
  kind: FortranUnitKind;
  /** Host unit (module or program) of an internal or module procedure. */
  host?: string;
  endLine: number;
  args: string[];
  /** FUNCTION type prefix or RESULT variable type when stated. */
  resultType?: string;
  prefixes: string[];
  /** IMPLICIT NONE, an IMPLICIT statement as written, or undefined (default I-N rule). */
  implicit?: string;
  implicitAt?: Loc;
  decls: FortranDecl[];
  uses: Array<Loc & { module: string; only?: string[]; intrinsic?: boolean }>;
  commons: FortranCommon[];
  equivalences: Array<Loc & { groups: string[][] }>;
  includes: Array<Loc & { name: string }>;
  calls: FortranCallSite[];
  io: FortranIo[];
  entries: Array<Loc & { name: string }>;
  /** The comment block right above the unit header. */
  doc?: string;
  /** Upper-case names followed by `(` in executable statements (for function references). */
  refs: Array<Loc & { name: string }>;
};

export type FortranFile = {
  path: string;
  form: "fixed" | "free";
  units: FortranUnit[];
  /**
   * Specification statements outside any program unit: the content of an include file
   * (declarations, COMMON, EQUIVALENCE, PARAMETER), attributed to each unit that INCLUDEs it.
   */
  fragment?: FortranUnit;
  statements: number;
  gaps: EngineGap[];
};
