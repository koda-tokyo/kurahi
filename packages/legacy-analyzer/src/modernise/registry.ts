// Language and assistant registry of the modernisation assistant. Each entry says whether an
// analysis engine exists ("active") or not yet ("planned"), and how its files are recognised
// (extension, then content sniffing of the first bytes). A planned entry only reports which files
// it would cover: nothing is analysed for it and no facts are produced.

import type { ScannedFile } from "./scan-types.js";

export type LanguageId =
  | "cobol"
  | "java"
  | "sql-ddl"
  | "fortran"
  | "pli"
  | "plc-iec61131"
  | "batch-scheduler"
  | "maintenance"
  | "cybersecurity";

export type LanguageDef = {
  id: LanguageId;
  label: { en: string; ja: string };
  status: "active" | "planned";
  /** What the engine does today (active) or what is planned and not available (planned). */
  description: string;
  /** Name of the engine that analyses these files (active entries only). */
  engine?: "cobol-jcl" | "java" | "sql-ddl" | "fortran" | "pli" | "plc";
  /** Files of the project this entry recognises. */
  detect(files: ScannedFile[]): ScannedFile[];
};

const byExt = (exts: string[]) => {
  const set = new Set(exts);
  return (f: ScannedFile) => set.has(f.ext);
};
const sniff = (re: RegExp, exts?: string[]) => (f: ScannedFile) =>
  (exts === undefined || exts.includes(f.ext)) && re.test(f.head);

/** Extensions whose content is sniffed (no reliable extension of their own). */
const AMBIGUOUS = ["", ".txt", ".src", ".inc", ".xml", ".dat", ".csv", ".lst"];

const isCobolExt = byExt([
  ".cbl",
  ".cob",
  ".cobol",
  ".ccp",
  ".cpy",
  ".copy",
  ".jcl",
  ".proc",
  ".prc",
]);
const isJava = byExt([".java"]);
const isSqlExt = byExt([".sql", ".ddl", ".db2", ".pgsql", ".psql"]);

export const LANGUAGES: LanguageDef[] = [
  {
    id: "cobol",
    label: { en: "COBOL / JCL", ja: "COBOL / JCL" },
    status: "active",
    engine: "cobol-jcl",
    description:
      "Programs, copybooks and JCL: paragraphs, PERFORM/CALL graphs, file and EXEC SQL/CICS access, data dictionary, rule candidates, impact, design document and wave plan.",
    detect: (fs) =>
      fs.filter(
        (f) =>
          isCobolExt(f) ||
          sniff(/^.{6}[ ]*(IDENTIFICATION|ID)\s+DIVISION/im, AMBIGUOUS)(f) ||
          sniff(/^\/\/[A-Z0-9#@$]{1,8}\s+JOB\s/m, AMBIGUOUS)(f),
      ),
  },
  {
    id: "java",
    label: { en: "Java", ja: "Java" },
    status: "active",
    engine: "java",
    description:
      "Classes, interfaces, enums, records, methods and fields with path:line; inheritance; statically resolvable call edges; Spring and JPA annotations; table access from JPA mappings, Spring Data repositories, @Query, JDBC SQL literals and MyBatis mapper XML statements.",
    detect: (fs) =>
      fs.filter(
        (f) =>
          isJava(f) ||
          sniff(/mybatis\.org\/\/DTD Mapper|<mapper\s[^>]*\bnamespace\s*=/i, [".xml"])(f),
      ),
  },
  {
    id: "sql-ddl",
    label: { en: "SQL DDL", ja: "SQL DDL" },
    status: "active",
    engine: "sql-ddl",
    description:
      "CREATE TABLE / VIEW / INDEX, columns with types, nullability and defaults, primary, foreign and unique keys, comments (ANSI, DB2, Oracle, PostgreSQL basics); stored procedures, functions and triggers with a BEGIN ... END body (DB2 SQL PL, Oracle PL/SQL): table access per statement, CALLs between routines and trigger events, dynamic SQL as gaps; a table name two schemas define gets one node per schema under the bare-name node.",
    detect: (fs) =>
      fs.filter(
        (f) =>
          isSqlExt(f) || sniff(/^\s*CREATE\s+(OR\s+REPLACE\s+)?(TABLE|VIEW)\s/im, AMBIGUOUS)(f),
      ),
  },
  {
    id: "fortran",
    label: { en: "FORTRAN", ja: "FORTRAN" },
    status: "active",
    engine: "fortran",
    description:
      "Fixed form (FORTRAN 77) and free form (Fortran 90+): PROGRAM, SUBROUTINE, FUNCTION, MODULE and BLOCK DATA units with path:line; CALL edges and function references resolved to units of the sources; USE and INCLUDE; COMMON blocks across units with member types (explicit or implicit) and layout checks; EQUIVALENCE; file I/O from OPEN/READ/WRITE unit numbers and FILE= names (FTnnF001 DD names otherwise).",
    detect: (fs) =>
      fs.filter(
        (f) =>
          byExt([".f", ".for", ".f77", ".ftn", ".fpp", ".f90", ".f95", ".f03", ".f08", ".f18"])(
            f,
          ) || sniff(/^\s{6,}(PROGRAM|SUBROUTINE)\s+\w+/m, AMBIGUOUS)(f),
      ),
  },
  {
    id: "pli",
    label: { en: "PL/I", ja: "PL/I" },
    status: "active",
    engine: "pli",
    description:
      "Procedures (OPTIONS(MAIN), nested internal procedures) with path:line; CALL edges; %INCLUDE members; DECLARE structures with levels and attributes (FIXED DECIMAL/BINARY, CHAR, PIC, BASED, DEFINED); FILE declarations and record/stream I/O bound to JCL DD statements; EXEC SQL table access joined with the SQL DDL; ON-units.",
    detect: (fs) =>
      fs.filter(
        (f) =>
          byExt([".pli", ".pl1", ".plinc"])(f) ||
          sniff(/\bPROC(EDURE)?\s+OPTIONS\s*\(\s*MAIN/i, AMBIGUOUS)(f),
      ),
  },
  {
    id: "plc-iec61131",
    label: {
      en: "PLC (IEC 61131-3: Structured Text, ladder exports)",
      ja: "PLC (IEC 61131-3: ST・ラダー出力)",
    },
    status: "active",
    engine: "plc",
    description:
      "Structured Text sources (.st, .scl, .iecst): PROGRAM, FUNCTION_BLOCK and FUNCTION units with path:line; VAR sections with AT %I/%Q/%M addresses joined into an I/O map, addresses declared twice, function block instances resolved to their definition, assignments; TYPE structs, enums and aliases. PLCopen XML exports (TC6 0201): the same facts at the XML line, Structured Text bodies read, FBD/LD block calls and output/coil writes read, IL/SFC bodies reported as gaps. Source text only, never a controller. Vendor ladder exports (.l5x, .l5k, .tia, .exp) are counted, not read yet.",
    detect: (fs) =>
      fs.filter(
        (f) =>
          byExt([".st", ".scl", ".iecst", ".l5x", ".l5k", ".tia"])(f) ||
          sniff(/plcopen\.org\/xml\/tc6|\bFUNCTION_BLOCK\b|\bEND_PROGRAM\b/i, [
            ...AMBIGUOUS,
            ".exp",
          ])(f),
      ),
  },
  {
    id: "batch-scheduler",
    label: {
      en: "Batch schedulers (Control-M, JP1/AJS, AutoSys, cron)",
      ja: "バッチスケジューラ (Control-M・JP1/AJS・AutoSys・cron)",
    },
    status: "planned",
    description:
      "Planned: no scheduler engine yet. Job-definition exports are counted only; schedules, dependencies and calendars are not linked to the JCL job flow.",
    detect: (fs) =>
      fs.filter(
        (f) =>
          byExt([".jil", ".ajs"])(f) ||
          sniff(/<DEFTABLE\b|<SMART_FOLDER\b|^\s*unit=|^\s*insert_job:/im, [...AMBIGUOUS, ".jil"])(
            f,
          ) ||
          /(^|\/)crontab$/.test(f.path),
      ),
  },
  {
    id: "maintenance",
    label: {
      en: "Maintenance records (work orders, asset registers)",
      ja: "保全記録 (作業指示・設備台帳)",
    },
    status: "planned",
    description:
      "Planned: no maintenance assistant yet. CSV exports whose header names work orders, assets or failure codes are counted only; nothing is analysed.",
    detect: (fs) =>
      fs.filter(sniff(/^[^\n]*(work_?order|asset_?id|equipment_?id|failure_?code)/i, [".csv"])),
  },
  {
    id: "cybersecurity",
    label: { en: "Cybersecurity review", ja: "サイバーセキュリティ点検" },
    status: "planned",
    description:
      "Planned: no security assistant yet. Not detected from files; no findings are produced and the absence of findings means nothing.",
    detect: () => [],
  },
];

export type Detection = {
  id: LanguageId;
  label: { en: string; ja: string };
  status: "active" | "planned";
  description: string;
  engine?: string;
  files: number;
  /** Up to 10 detected paths, sorted. */
  examples: string[];
  /**
   * Files whose content also matched this engine but that were routed to another one (see
   * HOST_FIRST); present only when non-zero.
   */
  routedElsewhere?: number;
};

/**
 * Routing of content-sniffed files (no reliable extension) that match more than one active
 * engine: the file goes to the first engine of this list only. A host-language program or job
 * that embeds SQL (EXEC SQL CREATE VIEW, in-stream DDL under SYSIN) is that program or job, not
 * a DDL script, exactly as it would be with a .cbl or .jcl extension.
 */
const HOST_FIRST: LanguageId[] = ["cobol", "pli", "fortran", "java", "sql-ddl", "plc-iec61131"];

/**
 * What each registry entry recognises in the scanned files. Planned entries may overlap (they
 * only count); a content-sniffed file is routed to one active engine only (HOST_FIRST).
 */
export function detectLanguages(files: ScannedFile[]): {
  detections: Detection[];
  byLanguage: Map<LanguageId, ScannedFile[]>;
} {
  const hits = new Map(LANGUAGES.map((l) => [l.id, l.detect(files)]));
  const owner = new Map<ScannedFile, LanguageId>();
  for (const id of HOST_FIRST) {
    for (const f of hits.get(id) ?? []) {
      if (AMBIGUOUS.includes(f.ext) && !owner.has(f)) {
        owner.set(f, id);
      }
    }
  }
  const byLanguage = new Map<LanguageId, ScannedFile[]>();
  const detections = LANGUAGES.map((l) => {
    const all = hits.get(l.id) ?? [];
    const hit = l.status === "active" ? all.filter((f) => (owner.get(f) ?? l.id) === l.id) : all;
    byLanguage.set(l.id, hit);
    const elsewhere = all.length - hit.length;
    return {
      id: l.id,
      label: l.label,
      status: l.status,
      description: l.description,
      ...(l.engine ? { engine: l.engine } : {}),
      files: hit.length,
      examples: hit.slice(0, 10).map((f) => f.path),
      ...(elsewhere > 0 ? { routedElsewhere: elsewhere } : {}),
    };
  });
  return { detections, byLanguage };
}
