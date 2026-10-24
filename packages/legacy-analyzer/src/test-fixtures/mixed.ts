// A small mixed fixture for the graph, design-document and wave-plan tests: indexed file I/O,
// EXEC SQL and EXEC CICS, a static, a dynamic and an unresolved CALL, a missing copybook, a
// CALL cycle (ORDMAIN -> ORDLOG -> LINK ORDMAIN) and a two-step job that passes a data set.

import { A, B, C, program } from "./helpers.js";

export const ORDREC = [
  C(" ORDREC - ORDER MASTER RECORD"),
  A("01  ORD-REC."),
  B("05 ORD-ID PIC X(6)."),
  B("05 ORD-STATUS PIC X."),
  B("   88 ORD-OPEN VALUE 'O'."),
  B("   88 ORD-CLOSED VALUE 'C'."),
  B("05 ORD-AMT PIC S9(7)V99 COMP-3."),
  B("05 ORD-LINES OCCURS 3 TIMES."),
  B("   10 ORD-SKU PIC X(4)."),
  B("05 ORD-DATE PIC X(8)."),
  B("05 ORD-DATE-N REDEFINES ORD-DATE PIC 9(8)."),
].join("\n");

export const ORDMAIN = program("ORDMAIN", {
  env: [
    A("INPUT-OUTPUT SECTION."),
    A("FILE-CONTROL."),
    B("SELECT ORD-FILE ASSIGN TO ORDMAST"),
    B("    ORGANIZATION IS INDEXED ACCESS IS DYNAMIC"),
    B("    RECORD KEY IS ORD-ID."),
    B("SELECT OUT-FILE ASSIGN TO ORDOUT."),
  ],
  data: [
    A("FILE SECTION."),
    A("FD  ORD-FILE."),
    B("COPY ORDREC."),
    A("FD  OUT-FILE."),
    A("01  OUT-REC PIC X(40)."),
    A("WORKING-STORAGE SECTION."),
    B("COPY NOSUCH."),
    A("01  WS-PGM PIC X(8) VALUE 'ORDDYN'."),
    A("01  WS-LIMIT PIC 9(5) VALUE 05000."),
    A("01  WS-CUST PIC X(6)."),
  ],
  proc: [
    A("0000-MAIN."),
    B("OPEN I-O ORD-FILE OUTPUT OUT-FILE"),
    B("PERFORM 1000-READ"),
    B("PERFORM 2000-UPDATE THRU 2000-EXIT"),
    B("CLOSE ORD-FILE OUT-FILE"),
    B("STOP RUN."),
    A("1000-READ."),
    B("READ ORD-FILE"),
    B("    INVALID KEY MOVE 'C' TO ORD-STATUS"),
    B("END-READ"),
    B("EXEC SQL SELECT CUST_ID INTO :WS-CUST FROM CUSTOMER"),
    B("    WHERE ORDER_ID = :ORD-ID END-EXEC."),
    A("2000-UPDATE."),
    B("IF ORD-AMT > WS-LIMIT"),
    B("    CALL 'ORDLOG' USING ORD-REC"),
    B("    REWRITE ORD-REC"),
    B("ELSE"),
    B("    DELETE ORD-FILE"),
    B("END-IF"),
    B("EXEC SQL INSERT INTO ORDER_HIST VALUES (:ORD-ID) END-EXEC"),
    B("EXEC SQL UPDATE CUSTOMER SET LAST_ORDER = :ORD-ID END-EXEC"),
    B("CALL WS-PGM"),
    B("CALL 'EXTUTIL'"),
    B("WRITE OUT-REC."),
    A("2000-EXIT."),
    B("EXIT."),
    A("9000-UNUSED."),
    B("DISPLAY 'NEVER PERFORMED'."),
  ],
});

export const ORDLOG = program("ORDLOG", {
  data: [
    A("WORKING-STORAGE SECTION."),
    A("01  WS-LOG PIC X(80)."),
    A("LINKAGE SECTION."),
    A("01  LK-REC PIC X(40)."),
  ],
  using: "LK-REC",
  proc: [
    A("0000-MAIN."),
    B("EXEC CICS READ FILE('CUSTF') INTO(WS-LOG)"),
    B("    RIDFLD(LK-REC) END-EXEC"),
    B("EXEC CICS WRITE FILE('LOGF') FROM(WS-LOG)"),
    B("    RIDFLD(LK-REC) END-EXEC"),
    B("EXEC CICS LINK PROGRAM('ORDMAIN') END-EXEC"),
    B("GOBACK."),
  ],
});

export const ORDRPT = program("ORDRPT", {
  env: [A("INPUT-OUTPUT SECTION."), A("FILE-CONTROL."), B("SELECT IN-FILE ASSIGN TO RPTIN.")],
  data: [A("FILE SECTION."), A("FD  IN-FILE."), A("01  IN-REC PIC X(40).")],
  proc: [
    A("0000-MAIN."),
    B("OPEN INPUT IN-FILE"),
    B("READ IN-FILE AT END CONTINUE END-READ"),
    B("CLOSE IN-FILE"),
    B("STOP RUN."),
  ],
});

export const ORDJOB = [
  "//ORDJOB   JOB (A),'ORDERS'",
  "//S10      EXEC PGM=ORDMAIN",
  "//ORDMAST  DD DSN=PROD.ORDMAST,DISP=OLD",
  "//ORDOUT   DD DSN=&&ORDTMP,DISP=(NEW,PASS)",
  "//S20      EXEC PGM=IEBGENER",
  "//SYSUT1   DD DSN=&&ORDTMP,DISP=(OLD,DELETE)",
  "//SYSUT2   DD DSN=PROD.ORDCOPY,DISP=(NEW,CATLG)",
  "//S30      EXEC PGM=ORDRPT",
  "//RPTIN    DD DSN=PROD.ORDCOPY,DISP=SHR",
].join("\n");

export const MIXED_FILES: Record<string, string> = {
  "cobol/ORDMAIN.cbl": ORDMAIN,
  "cobol/ORDLOG.cbl": ORDLOG,
  "cobol/ORDRPT.cbl": ORDRPT,
  "copy/ORDREC.cpy": ORDREC,
  "jcl/ORDJOB.jcl": ORDJOB,
  "notes/README.txt": "not a source file",
};
