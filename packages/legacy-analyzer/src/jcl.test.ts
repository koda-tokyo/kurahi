import { describe, expect, it } from "vitest";
import { expandProcs, parseJcl, splitOperands, substitute } from "./jcl.js";

const job = [
  "//NIGHTLY  JOB (ACCT),'NIGHT RUN',CLASS=A,",
  "//             MSGCLASS=X",
  "//* a comment",
  "//         SET DAY=20260930",
  "//STEP1    EXEC PGM=EXTRACT,PARM='&DAY'",
  "//IN       DD DSN=PROD.SALES.D&DAY,DISP=SHR",
  "//OUT      DD DSN=&&TEMP,DISP=(NEW,PASS),",
  "//            SPACE=(TRK,(5,5))",
  "//REPORT   DD SYSOUT=*",
  "//SYSIN    DD *",
  "  CONTROL CARD",
  "/*",
  "//STEP2    EXEC LOADPROC",
  "//LOADPROC PROC",
  "//LOAD     EXEC PGM=LOADER",
  "//MASTER   DD DSN=PROD.MASTER,DISP=OLD",
  "//         PEND",
].join("\n");

describe("JCL", () => {
  it("parses steps, programs, DD data sets and symbols", () => {
    const { jobs } = parseJcl("j.jcl", job);
    expandProcs(jobs);
    const nightly = jobs.find((j) => j.name === "NIGHTLY");
    expect(nightly?.symbols).toEqual({ DAY: "20260930" });
    const [s1, s2] = nightly?.steps ?? [];
    expect(s1).toMatchObject({ name: "STEP1", program: "EXTRACT", parm: "20260930", line: 5 });
    expect(s1.dds.map((d) => [d.ddname, d.dsn ?? d.sysout ?? "", d.access])).toEqual([
      ["IN", "PROD.SALES.D20260930", "input"],
      ["OUT", "&&TEMP", "output"],
      ["REPORT", "*", "sysout"],
      ["SYSIN", "", "instream"],
    ]);
    expect(s2).toMatchObject({ name: "STEP2", proc: "LOADPROC" });
    expect(s2.procSteps?.[0]).toMatchObject({ name: "LOAD", program: "LOADER" });
    expect(s2.procSteps?.[0].dds[0]).toMatchObject({ dsn: "PROD.MASTER", access: "exclusive" });
  });

  it("splits operands on top-level commas only and substitutes symbols", () => {
    expect(splitOperands("DSN=A.B,DISP=(NEW,CATLG),PARM='X,Y'")).toEqual([
      "DSN=A.B",
      "DISP=(NEW,CATLG)",
      "PARM='X,Y'",
    ]);
    expect(substitute("A.&X..B.&&T", { X: "1" })).toBe("A.1.B.&&T");
  });
});
