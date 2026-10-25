// Fact model of the PLC engine (IEC 61131-3 Structured Text). Every fact carries the file
// (root-relative, POSIX) and the 1-based line it was read from. The engine reads source text only:
// it never connects to a controller. PLCopen XML is read by plcopen-xml.ts into the same model;
// vendor ladder exports are not read yet.

import type { Loc } from "../types.js";
import type { EngineGap } from "./types.js";

export type PlcVarSection =
  | "VAR"
  | "VAR_INPUT"
  | "VAR_OUTPUT"
  | "VAR_IN_OUT"
  | "VAR_GLOBAL"
  | "VAR_EXTERNAL"
  | "VAR_TEMP"
  | "VAR_STAT"
  | "VAR_INST";

/** Direct address prefix: %I input, %Q output, %M memory. */
export type PlcAddressArea = "input" | "output" | "memory";

export type PlcVar = Loc & {
  name: string;
  section: PlcVarSection;
  /** CONSTANT, RETAIN, NON_RETAIN, PERSISTENT as written after the section keyword. */
  qualifiers: string[];
  /** Type as written, whitespace collapsed: `BOOL`, `ARRAY [1..10] OF INT`, `TON`. */
  type: string;
  /** `%IX0.0`, `%QW4`, or `%I*` (located later in a VAR_CONFIG). */
  address?: string;
  area?: PlcAddressArea;
  init?: string;
};

export type PlcCall = Loc & {
  /** Callee as written: `Motor1`, `LIMIT`, `Line.Drive`. */
  name: string;
  /** instance: the callee is a variable of this POU (or a global) holding a function block. */
  kind: "instance" | "function";
  /** Type of the instance (instance calls only). */
  type?: string;
};

export type PlcWrite = Loc & { target: string };

export type PlcPou = Loc & {
  name: string;
  kind: "PROGRAM" | "FUNCTION_BLOCK" | "FUNCTION";
  endLine: number;
  /** FUNCTION result type. */
  returns?: string;
  extends?: string;
  implements: string[];
  /** Comment directly above the header, as written. */
  doc?: string;
  vars: PlcVar[];
  calls: PlcCall[];
  writes: PlcWrite[];
};

export type PlcType = Loc & { name: string; kind: "struct" | "enum" | "alias"; endLine: number };

export type PlcFile = {
  path: string;
  pous: PlcPou[];
  types: PlcType[];
  /** VAR_GLOBAL blocks outside any POU (CONFIGURATION / RESOURCE or a global variable list). */
  globals: PlcVar[];
  gaps: EngineGap[];
};

export type PlcIoPoint = Loc & {
  address: string;
  area: PlcAddressArea;
  name: string;
  /** POU that declares it; absent for a global. */
  pou?: string;
  type: string;
};

export type PlcAnalysis = {
  files: string[];
  pous: PlcPou[];
  types: PlcType[];
  globals: PlcVar[];
  /** Every located variable, ordered by address. */
  io: PlcIoPoint[];
  /** Instance calls whose function block type is defined in the analysed sources. */
  instances: Array<Loc & { pou: string; instance: string; type: string; definedAt?: Loc }>;
  /** Addresses declared by more than one variable. */
  sharedAddresses: Array<{ address: string; by: Loc[] }>;
  gaps: EngineGap[];
};
