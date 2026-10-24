import { describe, expect, it } from "vitest";
import { CALIB_F90, GRID_CMN, HEATSV_F, PHYSICS_F90, STEP_F } from "../test-fixtures/sci-batch.js";
import { parseFortranFile } from "./fortran-parser.js";
import { analyseFortran, memberText } from "./fortran-resolve.js";
import { fortranForm, fortranStatements } from "./fortran-source.js";

const SOURCES: Record<string, string> = {
  "fortran/HEATSV.f": HEATSV_F,
  "fortran/STEP.f": STEP_F,
  "fortran/physics.f90": PHYSICS_F90,
  "fortran/calib.f90": CALIB_F90,
};
const grid = parseFortranFile("fortran/GRID.CMN", GRID_CMN);
const include = (name: string) => (name === "GRID.CMN" ? grid : null);
const analyse = (paths = Object.keys(SOURCES)) =>
  analyseFortran(
    paths.map((p) => parseFortranFile(p, SOURCES[p])),
    include,
  );
const a = analyse();

describe("FORTRAN source form", () => {
  it("tells fixed from free form and joins continuation lines", () => {
    expect(fortranForm("x.f", "")).toBe("fixed");
    expect(fortranForm("x.f90", "")).toBe("free");
    expect(fortranForm("x.src", "C     COMMENT\n      PROGRAM P\n      END")).toBe("fixed");
    const fixed = fortranStatements(HEATSV_F, "fixed").stmts;
    expect(fixed.find((s) => s.text.startsWith("CALL STEP"))).toEqual({
      text: "CALL STEP(DT,          ALPHA)",
      line: 15,
    });
    expect(fixed.find((s) => s.text.startsWith("CONTINUE"))?.label).toBe("100");
    const free = fortranStatements(PHYSICS_F90, "free").stmts;
    expect(free.find((s) => s.text.startsWith("OPEN"))).toMatchObject({ line: 18 });
    expect(free.find((s) => s.text.startsWith("OPEN"))?.text).toContain("ACTION='read'");
    const semi = fortranStatements(CALIB_F90, "free").stmts.filter((s) => s.line === 10);
    expect(semi.map((s) => s.text.split("(")[0])).toEqual(["OPEN", "WRITE"]);
  });
});

describe("FORTRAN engine", () => {
  it("reads program units with path:line, hosts, implicit typing and header comments", () => {
    expect(
      a.units.map((u) => `${u.kind} ${u.id} ${u.file}:${u.line}-${u.endLine} ${u.implicit ?? "-"}`),
    ).toEqual([
      "program CALIB fortran/calib.f90:1-12 NONE",
      "program HEATSV fortran/HEATSV.f:3-24 NONE",
      "subroutine INITT fortran/STEP.f:17-25 -",
      "subroutine LOGSTP fortran/STEP.f:36-42 -",
      "module PHYSICS fortran/physics.f90:2-24 NONE",
      "function PHYSICS.DIFFUSIVITY fortran/physics.f90:9-13 -",
      "subroutine PHYSICS.LOAD_MATERIAL fortran/physics.f90:15-23 -",
      "block-data STATS0 fortran/STEP.f:44-47 -",
      "subroutine STEP fortran/STEP.f:2-15 IMPLICIT DOUBLE PRECISION (A-H, O-Z)",
      "function TMAX fortran/STEP.f:27-34 -",
    ]);
    const heat = a.units.find((u) => u.id === "HEATSV");
    expect(heat?.doc).toMatch(/^HEATSV: 1-D HEAT CONDUCTION/);
    expect(heat?.decls.find((d) => d.name === "NSTEP")).toMatchObject({
      type: "INTEGER",
      attrs: ["PARAMETER"],
      value: "500",
      line: 6,
    });
    expect(a.units.find((u) => u.id === "TMAX")?.resultType).toBe("DOUBLE PRECISION");
    const phys = a.units.find((u) => u.id === "PHYSICS");
    expect(phys?.decls.map((d) => `${d.name} ${d.type} ${d.attrs.join(",")}`)).toEqual([
      "DP INTEGER PARAMETER",
      "RHO REAL(KIND=DP) PARAMETER",
      "CONDUCTIVITY REAL(DP) ",
    ]);
  });

  it("maps COMMON blocks across units, through INCLUDE, with types and layout checks", () => {
    expect(a.includeFiles).toEqual(["fortran/GRID.CMN"]);
    const g = a.commons.find((c) => c.name === "GRID");
    expect(g?.layout).toBe("names differ");
    expect(g?.users.map((u) => `${u.unit} ${u.file}:${u.line} ${u.via ?? "-"}`)).toEqual([
      "HEATSV fortran/GRID.CMN:6 fortran/GRID.CMN",
      "INITT fortran/GRID.CMN:6 fortran/GRID.CMN",
      "STEP fortran/STEP.f:4 -",
      "TMAX fortran/GRID.CMN:6 fortran/GRID.CMN",
    ]);
    expect(g?.users[0].members.map(memberText)).toEqual([
      "NX INTEGER",
      "DX REAL*8",
      "T(NMAX) REAL*8",
      "TNEW(NMAX) REAL*8",
    ]);
    // STEP declares the block by hand: N and H take their type from IMPLICIT DOUBLE PRECISION.
    expect(g?.users[2].members.map(memberText)).toEqual([
      "N INTEGER (implicit)",
      "H DOUBLE PRECISION (implicit)",
      "T(1000) DOUBLE PRECISION (implicit)",
      "TNEW(1000) DOUBLE PRECISION (implicit)",
    ]);
    expect(a.commons.find((c) => c.name === "STATS")?.layout).toBe("same");
    const mixed = analyseFortran([
      parseFortranFile("a.f", "      SUBROUTINE A\n      COMMON /W/ X, Y\n      END"),
      parseFortranFile(
        "b.f",
        "      SUBROUTINE B\n      INTEGER X\n      COMMON /W/ X, Y(2)\n      END",
      ),
    ]);
    expect(mixed.commons[0].layout).toBe("types or sizes differ");
  });

  it("resolves CALL edges and function references, USE and module procedures", () => {
    expect(
      a.calls.map((c) => `${c.from} -> ${c.to} ${c.form} [${c.resolution}] ${c.file}:${c.line}`),
    ).toEqual([
      "CALIB -> PHYSICS.LOAD_MATERIAL call [module] fortran/calib.f90:8",
      "CALIB -> PHYSICS.DIFFUSIVITY function [module] fortran/calib.f90:9",
      "HEATSV -> INITT call [external unit] fortran/HEATSV.f:12",
      "HEATSV -> STEP call [external unit] fortran/HEATSV.f:15",
      "HEATSV -> TMAX function [external unit] fortran/HEATSV.f:22",
      "STEP -> LOGSTP call [external unit] fortran/STEP.f:13",
    ]);
    expect(a.uses.map((u) => `${u.unit} ${u.module} ${u.resolved} ${u.intrinsic}`)).toEqual([
      "CALIB PHYSICS true false",
      "PHYSICS ISO_FORTRAN_ENV false true",
    ]);
    const lib = analyseFortran([
      parseFortranFile(
        "s.f",
        "      SUBROUTINE S\n      REAL A(3)\n      CALL DGEMM(A)\n      X = A(1)\n      END",
      ),
    ]);
    expect(lib.calls.map((c) => `${c.to} ${c.resolution}`)).toEqual([
      "DGEMM not in the FORTRAN sources",
    ]);
  });

  it("binds file I/O to FILE= names, else to FTnnF001, and lists what it cannot bind", () => {
    expect(
      a.fileUses.map(
        (u) => `${u.unit} ${u.op} ${u.target.kind}:${u.target.name} ${u.file}:${u.line}`,
      ),
    ).toEqual([
      "CALIB OPEN file:alpha.out fortran/calib.f90:10",
      "CALIB WRITE file:alpha.out fortran/calib.f90:10",
      "HEATSV OPEN file:grid.dat fortran/HEATSV.f:9",
      "HEATSV OPEN file:profile.out fortran/HEATSV.f:10",
      "HEATSV READ file:grid.dat fortran/HEATSV.f:11",
      "HEATSV WRITE file:profile.out fortran/HEATSV.f:18",
      "LOGSTP WRITE dd:FT12F001 fortran/STEP.f:38",
    ]);
    expect(a.fileUses.find((u) => u.op === "OPEN" && u.unit === "HEATSV")?.status).toBe("OLD");
    expect(a.unresolvedIo.map((u) => `${u.unit} ${u.op} ${u.reason} ${u.line}`)).toEqual([
      "PHYSICS.LOAD_MATERIAL OPEN file name from the expression PATH 18",
      "PHYSICS.LOAD_MATERIAL READ file name from the expression PATH 21",
    ]);
    expect(a.consoleIo).toBe(2);
    const elsewhere = analyseFortran([
      parseFortranFile("o.f", "      SUBROUTINE O\n      OPEN (30, FILE='LOG.TXT')\n      END"),
      parseFortranFile(
        "w.f",
        "      SUBROUTINE W\n      INTEGER IU\n      PARAMETER (IU = 30)\n      WRITE (IU, *) 1\n      WRITE (K, *) 2\n      END",
      ),
    ]);
    expect(
      elsewhere.fileUses.map((u) => `${u.unit} ${u.op} ${u.target.name} ${u.binding}`),
    ).toContain("W WRITE LOG.TXT OPEN of unit 30 in O (o.f:2)");
    expect(elsewhere.unresolvedIo.map((u) => u.reason)).toEqual(["unit given by the variable K"]);
  });

  it("reports constructs it does not model instead of guessing", () => {
    expect(a.gaps.map((g) => `${g.file}:${g.line} ${g.construct}`)).toEqual([
      "fortran/STEP.f:39 computed GO TO",
      "fortran/calib.f90:5 preprocessor",
      "fortran/calib.f90:7 preprocessor",
    ]);
    const odd = parseFortranFile(
      "odd.f",
      [
        "      SUBROUTINE ODD(X, *)",
        "      POINTER (IP, BUF)",
        "      ASSIGN 10 TO L",
        "      GO TO L",
        "      IF (X) 10, 20, 30",
        "      ENTRY ODD2(X)",
        "      CALL ODD(X, *10)",
        "      EXEC SQL SELECT 1 FROM T",
        "   10 RETURN 1",
      ].join("\n"),
    );
    expect(odd.gaps.map((g) => g.construct)).toEqual([
      "unterminated unit",
      "Cray pointer",
      "assigned GO TO",
      "assigned GO TO",
      "arithmetic IF",
      "ENTRY",
      "alternate return",
      "EXEC SQL",
      "alternate return",
    ]);
    const viaEntry = analyseFortran([
      odd,
      parseFortranFile("c.f", "      PROGRAM C\n      CALL ODD2(1.0)\n      END"),
    ]);
    expect(viaEntry.calls.find((c) => c.name === "ODD2")).toMatchObject({
      to: "ODD",
      resolution: "entry",
    });
  });

  it("is deterministic and independent of the file order", () => {
    const again = analyse(Object.keys(SOURCES).toReversed());
    expect(JSON.stringify({ ...again, files: [] })).toBe(JSON.stringify({ ...a, files: [] }));
    expect(JSON.stringify(analyse())).toBe(JSON.stringify(a));
  });

  it("never throws on truncated sources", () => {
    for (const [p, src] of Object.entries(SOURCES)) {
      for (let i = 0; i < src.length; i += 7) {
        expect(() =>
          analyseFortran(
            [parseFortranFile(p, src.slice(0, i)), parseFortranFile("rest.f90", src.slice(i))],
            include,
          ),
        ).not.toThrow();
      }
    }
  });
});
