// Toolchains for the local runner (KIMS-014): which language a snapshot holds, which compiler
// builds it, and that compiler's identity (path, first version line, binary SHA-256). COBOL uses
// GnuCOBOL `cobc -x`, FORTRAN `gfortran`. PL/I has no compiler here: it resolves to null and the
// run reports NOT_RUN_COMPILER_UNAVAILABLE, never a pass.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SourceLanguage, ToolchainIdentity } from "./types.js";
import { sha256Hex } from "../continuity-suite/manifest.js";

const EXT: Record<SourceLanguage, string[]> = {
  cobol: [".cbl", ".cob", ".cobol", ".cpy"],
  fortran: [".f", ".for", ".f77", ".f90", ".f95", ".f03", ".f08"],
  pli: [".pli", ".pl1", ".inc"],
};
const PROGRAM_EXT: Record<SourceLanguage, string[]> = {
  cobol: [".cbl", ".cob", ".cobol"],
  fortran: EXT.fortran,
  pli: [".pli", ".pl1"],
};
/** Compiler binaries tried per language, in order. PL/I: none is known to exist here. */
const COMPILERS: Record<SourceLanguage, string[]> = {
  cobol: ["cobc"],
  fortran: ["gfortran"],
  pli: ["pli", "plic", "ibm-pli"],
};

export function languageOfPath(rel: string): SourceLanguage | null {
  const ext = path.extname(rel).toLowerCase();
  for (const lang of Object.keys(EXT) as SourceLanguage[]) {
    if (EXT[lang].includes(ext)) {
      return lang;
    }
  }
  return null;
}

/** The single language of a file list (programs win over includes); unknown when mixed/none. */
export function detectLanguage(paths: string[]): SourceLanguage | "unknown" {
  const langs = new Set<SourceLanguage>();
  for (const p of paths) {
    const ext = path.extname(p).toLowerCase();
    for (const lang of Object.keys(PROGRAM_EXT) as SourceLanguage[]) {
      if (PROGRAM_EXT[lang].includes(ext)) {
        langs.add(lang);
      }
    }
  }
  return langs.size === 1 ? [...langs][0] : "unknown";
}

export function programFiles(lang: SourceLanguage, paths: string[]): string[] {
  return paths.filter((p) => PROGRAM_EXT[lang].includes(path.extname(p).toLowerCase())).toSorted();
}

function which(bin: string, envPath: string | undefined): string | null {
  for (const dir of (envPath ?? "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return fs.realpathSync(full);
    } catch {
      // not here
    }
  }
  return null;
}

export type ResolvedCompiler = { path: string; version: string; binarySha256: string };

/** The compiler for a language, or null when none is installed (or it does not run). */
export function resolveCompiler(
  lang: SourceLanguage,
  opts: { envPath?: string; override?: string } = {},
): ResolvedCompiler | null {
  const candidates = opts.override ? [opts.override] : COMPILERS[lang];
  for (const bin of candidates) {
    const full = path.isAbsolute(bin) ? bin : which(bin, opts.envPath ?? process.env.PATH);
    if (!full || !fs.existsSync(full)) {
      continue;
    }
    const probe = spawnSync(full, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    if (probe.status !== 0) {
      continue;
    }
    const version = (probe.stdout || "").split("\n")[0]?.trim() ?? "";
    return { path: full, version, binarySha256: sha256Hex(fs.readFileSync(full)) };
  }
  return null;
}

export function toolchainIdentity(
  lang: SourceLanguage | "unknown",
  compiler: ResolvedCompiler | null,
  opts: { dialect: string | null; flags: string[] },
): ToolchainIdentity {
  return {
    language: lang,
    compiler: compiler?.path ?? null,
    version: compiler?.version ?? null,
    binarySha256: compiler?.binarySha256 ?? null,
    dialect: lang === "cobol" ? opts.dialect : null,
    flags: [...opts.flags],
  };
}

/** Folders holding COBOL copybooks (passed to cobc with -I), relative to the source root. */
function includeDirs(paths: string[]): string[] {
  const dirs = new Set<string>(["."]);
  for (const p of paths) {
    if ([".cpy", ".inc"].includes(path.extname(p).toLowerCase())) {
      dirs.add(path.dirname(p));
    }
  }
  return [...dirs].toSorted();
}

/**
 * The compile command for a materialized snapshot in `srcDir` → `exe`. COBOL: the entry first
 * (the main program), other programs after it, copybook folders with -I. FORTRAN: every source
 * in one invocation (the entry, i.e. the PROGRAM unit, first).
 */
export function buildCommand(params: {
  lang: SourceLanguage;
  compiler: string;
  srcDir: string;
  paths: string[];
  entry: string;
  exe: string;
  dialect: string | null;
  flags: string[];
}): string[] {
  const programs = programFiles(params.lang, params.paths);
  const ordered = [params.entry, ...programs.filter((p) => p !== params.entry)].map((p) =>
    path.join(params.srcDir, p),
  );
  if (params.lang === "cobol") {
    return [
      params.compiler,
      "-x",
      ...(params.dialect ? [`-std=${params.dialect}`] : []),
      ...includeDirs(params.paths).flatMap((d) => ["-I", path.join(params.srcDir, d)]),
      ...params.flags,
      "-o",
      params.exe,
      ...ordered,
    ];
  }
  return [params.compiler, ...params.flags, "-o", params.exe, ...ordered];
}

/**
 * The entry source: the explicit one, else the only program that is a main program (COBOL:
 * any program, the one without LINKAGE SECTION when several; FORTRAN: the `program` unit).
 */
export function detectEntry(
  lang: SourceLanguage,
  files: Array<{ path: string; text: string }>,
  explicit: string | null,
): string {
  const programs = files.filter((f) => programFiles(lang, [f.path]).length > 0);
  if (explicit) {
    if (!programs.some((p) => p.path === explicit)) {
      throw new Error(`entry ${explicit} is not a ${lang} program in the snapshot`);
    }
    return explicit;
  }
  const mains =
    lang === "fortran"
      ? programs.filter((p) => /^\s*program\s+\w+/im.test(p.text))
      : lang === "cobol" && programs.length > 1
        ? programs.filter((p) => !/LINKAGE\s+SECTION/i.test(p.text))
        : programs;
  if (mains.length !== 1) {
    throw new Error(
      `cannot tell the entry program (${mains.length} candidates: ${mains.map((m) => m.path).join(", ") || "none"}); pass entry`,
    );
  }
  return mains[0].path;
}
