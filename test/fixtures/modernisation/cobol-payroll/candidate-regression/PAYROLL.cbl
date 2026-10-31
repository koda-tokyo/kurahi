      * PAYROLL - weekly gross-to-net (synthetic verification fixture).
      * Synthetic fixture written for Kurahi. SPDX-License-Identifier: MIT
      * CHG-001 plus an INJECTED REGRESSION: ROUNDED dropped from tax.
      * Overtime above WS-THRESHOLD hours is paid at 1.5x; tax is
      * 20.5% of a positive gross, ROUNDED; adjustments are signed.
       IDENTIFICATION DIVISION.
       PROGRAM-ID. PAYROLL.
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT PAY-IN ASSIGN TO "PAYIN.DAT"
               ORGANIZATION IS LINE SEQUENTIAL
               FILE STATUS IS WS-IN-STATUS.
           SELECT PAY-OUT ASSIGN TO "PAYOUT.DAT"
               ORGANIZATION IS LINE SEQUENTIAL.
           SELECT PAY-PK ASSIGN TO "PAYPK.DAT"
               ORGANIZATION IS SEQUENTIAL.
       DATA DIVISION.
       FILE SECTION.
       FD  PAY-IN.
           COPY EMPREC.
       FD  PAY-OUT.
       01  OUT-LINE                PIC X(64).
       FD  PAY-PK.
       01  PK-REC.
           05  PK-ID               PIC X(6).
           05  PK-GROSS            PIC S9(7)V99 COMP-3.
           05  PK-NET              PIC S9(7)V99 COMP-3.
       WORKING-STORAGE SECTION.
       01  WS-IN-STATUS            PIC XX.
       01  WS-EOF                  PIC X VALUE "N".
           88  END-OF-INPUT        VALUE "Y".
       01  WS-THRESHOLD            PIC 9(3)V9 COMP-3 VALUE 45.0.
       01  WS-OT-FACTOR            PIC 9V9 COMP-3 VALUE 1.5.
       01  WS-TAX-RATE             PIC V999 COMP-3 VALUE .205.
       01  WS-REG-HOURS            PIC 9(3)V9 COMP-3.
       01  WS-OT-HOURS             PIC 9(3)V9 COMP-3.
       01  WS-GROSS                PIC S9(7)V99 COMP-3.
       01  WS-TAX                  PIC S9(7)V99 COMP-3.
       01  WS-NET                  PIC S9(7)V99 COMP-3.
       01  WS-TOTALS.
           05  WS-TOT-GROSS        PIC S9(9)V99 COMP-3 VALUE 0.
           05  WS-TOT-NET          PIC S9(9)V99 COMP-3 VALUE 0.
           05  WS-COUNT-PAID       PIC 9(5) COMP-3 VALUE 0.
           05  WS-COUNT-SKIPPED    PIC 9(5) COMP-3 VALUE 0.
       01  WS-OUT.
           05  WO-ID               PIC X(6).
           05  FILLER              PIC X VALUE SPACE.
           05  WO-NAME             PIC X(20).
           05  FILLER              PIC X VALUE SPACE.
           05  WO-STATUS           PIC X.
           05  FILLER              PIC X VALUE SPACE.
           05  WO-GROSS            PIC -(7)9.99.
           05  FILLER              PIC X VALUE SPACE.
           05  WO-TAX              PIC -(7)9.99.
           05  FILLER              PIC X VALUE SPACE.
           05  WO-NET              PIC S9(7)V99
                                   SIGN LEADING SEPARATE.
       01  WS-DISP-AMOUNT          PIC -(9)9.99.
       01  WS-DISP-COUNT           PIC Z(4)9.
       PROCEDURE DIVISION.
       MAIN-PARA.
           OPEN INPUT PAY-IN
                OUTPUT PAY-OUT PAY-PK
           PERFORM UNTIL END-OF-INPUT
               READ PAY-IN
                   AT END SET END-OF-INPUT TO TRUE
                   NOT AT END PERFORM PROCESS-EMP
               END-READ
           END-PERFORM
           MOVE WS-TOT-GROSS TO WS-DISP-AMOUNT
           DISPLAY "TOTAL GROSS " WS-DISP-AMOUNT
           MOVE WS-TOT-NET TO WS-DISP-AMOUNT
           DISPLAY "TOTAL NET   " WS-DISP-AMOUNT
           MOVE WS-COUNT-PAID TO WS-DISP-COUNT
           DISPLAY "PAID        " WS-DISP-COUNT
           MOVE WS-COUNT-SKIPPED TO WS-DISP-COUNT
           DISPLAY "SKIPPED     " WS-DISP-COUNT
           CLOSE PAY-IN PAY-OUT PAY-PK
           STOP RUN.
       PROCESS-EMP.
           EVALUATE TRUE
               WHEN EMP-TERMINATED
                   ADD 1 TO WS-COUNT-SKIPPED
               WHEN EMP-ONLEAVE
                   MOVE ZERO TO WS-GROSS
                   ADD EMP-ADJ TO WS-GROSS
                   PERFORM TAX-AND-WRITE
               WHEN OTHER
                   PERFORM COMPUTE-GROSS
                   PERFORM TAX-AND-WRITE
           END-EVALUATE.
       COMPUTE-GROSS.
           IF EMP-HOURS > WS-THRESHOLD
               MOVE WS-THRESHOLD TO WS-REG-HOURS
               COMPUTE WS-OT-HOURS = EMP-HOURS - WS-THRESHOLD
           ELSE
               MOVE EMP-HOURS TO WS-REG-HOURS
               MOVE ZERO TO WS-OT-HOURS
           END-IF
           COMPUTE WS-GROSS ROUNDED =
                 WS-REG-HOURS * EMP-RATE
               + WS-OT-HOURS * EMP-RATE * WS-OT-FACTOR
               + EMP-ADJ.
       TAX-AND-WRITE.
           IF WS-GROSS > ZERO
               COMPUTE WS-TAX = WS-GROSS * WS-TAX-RATE
           ELSE
               MOVE ZERO TO WS-TAX
           END-IF
           COMPUTE WS-NET = WS-GROSS - WS-TAX
           ADD WS-GROSS TO WS-TOT-GROSS
           ADD WS-NET TO WS-TOT-NET
           ADD 1 TO WS-COUNT-PAID
           MOVE EMP-ID TO WO-ID PK-ID
           MOVE EMP-NAME TO WO-NAME
           MOVE EMP-STATUS TO WO-STATUS
           MOVE WS-GROSS TO WO-GROSS PK-GROSS
           MOVE WS-TAX TO WO-TAX
           MOVE WS-NET TO WO-NET PK-NET
           WRITE OUT-LINE FROM WS-OUT
           WRITE PK-REC.
