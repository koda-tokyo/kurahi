       IDENTIFICATION DIVISION.
       PROGRAM-ID. PAYCALC.
       AUTHOR. PY01 MAINTENANCE TEAM.
      *================================================================*
      * KAZANAMI PRECISION WORKS (FICTIONAL - DEMO ONLY)               *
      * PAYCALC - STEP030 OF JOB PY01MNTH. CALCULATES MONTHLY GROSS    *
      *           PAY WITH OVERTIME, HOLIDAY AND NIGHT PREMIUMS UNDER  *
      *           LABOUR STANDARDS ACT (LSA) ART.37.                   *
      * PARM    : PAY PERIOD AS YYYYMM (E.G. 202609).                  *
      * INPUT   : PAYIN  - VALIDATED EMPREC RECORDS, SORTED DEPT/ID.   *
      * OUTPUT  : PAYOUT - PAYREC RECORDS, SAME ORDER.                 *
      *----------------------------------------------------------------*
      * PREMIUM RATES (MULTIPLIERS ON THE HOURLY RATE)                 *
      *   OT UP TO 60H/MONTH ........ 1.25                             *
      *   OT OVER 60H/MONTH ......... 1.50  (SEE SME NOTE BELOW)       *
      *   STATUTORY HOLIDAY WORK .... 1.35  (NOT COUNTED IN THE 60H)   *
      *   NIGHT 22:00-05:00 ......... 0.25  (ADDED ON TOP)             *
      * MANAGERS (TYPE M, LSA ART.41) GET NO OT/HOLIDAY PREMIUM BUT    *
      * DO GET THE NIGHT PREMIUM.                                      *
      *----------------------------------------------------------------*
      * CHANGE LOG                                                     *
      * 1998-03-02  INITIAL VERSION                                    *
      * 2010-04-01  60H TIER ADDED (1.50). COMPANY IS AN SME SO THE    *
      *             TIER IS DEFERRED - SEE WS-SME-DEFERRAL-END.        *
      * 2014-10-01  FAMILY/COMMUTING ALLOWANCES TAKEN OUT OF THE       *
      *             HOURLY-RATE BASE (EMP-ALLOW-EXCL).                 *
      * 2023-04-01  SME DEFERRAL ENDED. 1.50 NOW APPLIES FROM PERIOD   *
      *             202304. OLD RULE KEPT FOR RE-RUNS OF PAST PERIODS. *
      * 2023-06-19  36-AGREEMENT ALERT FLAGS ADDED FOR HR (PAYRPT).    *
      *================================================================*
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT PAY-IN  ASSIGN TO "PAYIN"
                          ORGANIZATION IS LINE SEQUENTIAL
                          FILE STATUS IS WS-FS-IN.
           SELECT PAY-OUT ASSIGN TO "PAYOUT"
                          ORGANIZATION IS LINE SEQUENTIAL
                          FILE STATUS IS WS-FS-OUT.
       DATA DIVISION.
       FILE SECTION.
       FD  PAY-IN.
           COPY EMPREC.
       FD  PAY-OUT.
           COPY PAYREC.

       WORKING-STORAGE SECTION.
       01  WS-FS-IN                    PIC X(02).
       01  WS-FS-OUT                   PIC X(02).
       01  WS-EOF-SW                   PIC X(01) VALUE 'N'.
           88  END-OF-INPUT                      VALUE 'Y'.
       01  WS-PARM                     PIC X(06).
       01  WS-PERIOD                   PIC 9(06).

       01  WS-RATES.
           05  WS-OT1-RATE             PIC 9V99  VALUE 1.25.
           05  WS-OT2-RATE             PIC 9V99  VALUE 1.50.
           05  WS-HOL-RATE             PIC 9V99  VALUE 1.35.
           05  WS-NIGHT-RATE           PIC 9V99  VALUE 0.25.
           05  WS-OT-TIER-HOURS        PIC 9(03) VALUE 060.
           05  WS-SME-DEFERRAL-END     PIC 9(06) VALUE 202304.
       01  WS-36-LIMITS.
           05  WS-LIMIT-45H-MIN        PIC 9(05) VALUE 02700.
           05  WS-LIMIT-100H-MIN       PIC 9(05) VALUE 06000.

       01  WS-RND-MODE                 PIC X(01).
       01  WS-RND-IN                   PIC S9(09)V9(06).
       01  WS-RND-OUT                  PIC S9(09).

       01  WS-WORK.
           05  WS-RATE                 PIC 9(05).
           05  WS-OT-HRS               PIC 9(03).
           05  WS-HOL-HRS              PIC 9(03).
           05  WS-NIGHT-HRS            PIC 9(03).
           05  WS-OT-HOL-MIN           PIC 9(06).
       01  WS-COUNTERS.
           05  WS-READ-CNT             PIC 9(05) VALUE ZERO.
           05  WS-WRITE-CNT            PIC 9(05) VALUE ZERO.
           05  WS-GROSS-TOTAL          PIC 9(11) VALUE ZERO.

       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-INITIALISE
           PERFORM 2000-PROCESS UNTIL END-OF-INPUT
           PERFORM 9000-TERMINATE
           STOP RUN.

       1000-INITIALISE.
           ACCEPT WS-PARM FROM COMMAND-LINE
           IF WS-PARM NOT NUMERIC
               DISPLAY 'PAYCALC: PARM MUST BE YYYYMM, GOT ' WS-PARM
               MOVE 16 TO RETURN-CODE
               STOP RUN
           END-IF
           MOVE WS-PARM TO WS-PERIOD
      *    SME DEFERRAL: BEFORE 202304 THE 60H TIER PAID 1.25 ONLY.
           IF WS-PERIOD < WS-SME-DEFERRAL-END
               MOVE 1.25 TO WS-OT2-RATE
           END-IF
           OPEN INPUT PAY-IN OUTPUT PAY-OUT
           IF WS-FS-IN NOT = '00'
               DISPLAY 'PAYCALC: CANNOT OPEN PAYIN, STATUS ' WS-FS-IN
               MOVE 16 TO RETURN-CODE
               STOP RUN
           END-IF
           PERFORM 8000-READ-INPUT.

       2000-PROCESS.
           ADD 1 TO WS-READ-CNT
           MOVE SPACES TO PAY-RECORD
           INITIALIZE PAY-RECORD
           MOVE EMP-ID   TO PAY-ID
           MOVE EMP-DEPT TO PAY-DEPT
           MOVE EMP-NAME TO PAY-NAME
           MOVE EMP-TYPE TO PAY-TYPE
           PERFORM 3000-BASE-AND-RATE
           PERFORM 4000-ROUND-HOURS
           PERFORM 5000-PREMIUMS
           PERFORM 6000-ALERTS
           COMPUTE PAY-GROSS-AMT = PAY-BASE-AMT  + PAY-ALLOW-AMT
                                 + PAY-OT1-AMT   + PAY-OT2-AMT
                                 + PAY-HOL-AMT   + PAY-NIGHT-AMT
           ADD PAY-GROSS-AMT TO WS-GROSS-TOTAL
           WRITE PAY-RECORD
           ADD 1 TO WS-WRITE-CNT
           PERFORM 8000-READ-INPUT.

      *----------------------------------------------------------------*
      * HOURLY RATE. MONTHLY STAFF: (BASE + INCLUDED ALLOWANCES) /     *
      * AVERAGE MONTHLY SCHEDULED HOURS, ROUNDED TO THE YEN. FAMILY    *
      * AND COMMUTING ALLOWANCES ARE PAID BUT NOT PART OF THE BASE.    *
      * HOURLY STAFF: RATE AS GIVEN, BASE PAY = RATE X MINUTES / 60.   *
      *----------------------------------------------------------------*
       3000-BASE-AND-RATE.
           COMPUTE PAY-ALLOW-AMT = EMP-ALLOW-INCL + EMP-ALLOW-EXCL
           IF EMP-PART-TIME
               MOVE EMP-BASE-PAY TO WS-RATE
               COMPUTE WS-RND-IN = WS-RATE * EMP-REG-MIN / 60
               MOVE 'Y' TO WS-RND-MODE
               CALL 'PAYRND' USING WS-RND-MODE WS-RND-IN WS-RND-OUT
               MOVE WS-RND-OUT TO PAY-BASE-AMT
           ELSE
               MOVE EMP-BASE-PAY TO PAY-BASE-AMT
               COMPUTE WS-RND-IN = (EMP-BASE-PAY + EMP-ALLOW-INCL)
                                 / EMP-SCHED-HRS
               MOVE 'Y' TO WS-RND-MODE
               CALL 'PAYRND' USING WS-RND-MODE WS-RND-IN WS-RND-OUT
               MOVE WS-RND-OUT TO WS-RATE
           END-IF
           MOVE WS-RATE TO PAY-HOURLY-RATE.

       4000-ROUND-HOURS.
           MOVE 'H' TO WS-RND-MODE
           MOVE EMP-OT-MIN TO WS-RND-IN
           CALL 'PAYRND' USING WS-RND-MODE WS-RND-IN WS-RND-OUT
           MOVE WS-RND-OUT TO WS-OT-HRS
           MOVE EMP-HOL-MIN TO WS-RND-IN
           CALL 'PAYRND' USING WS-RND-MODE WS-RND-IN WS-RND-OUT
           MOVE WS-RND-OUT TO WS-HOL-HRS
           MOVE EMP-NIGHT-MIN TO WS-RND-IN
           CALL 'PAYRND' USING WS-RND-MODE WS-RND-IN WS-RND-OUT
           MOVE WS-RND-OUT TO WS-NIGHT-HRS
           MOVE WS-OT-HRS    TO PAY-OT-HRS
           MOVE WS-HOL-HRS   TO PAY-HOL-HRS
           MOVE WS-NIGHT-HRS TO PAY-NIGHT-HRS.

       5000-PREMIUMS.
           MOVE 'Y' TO WS-RND-MODE
           IF NOT EMP-MANAGER
               IF WS-OT-HRS > WS-OT-TIER-HOURS
                   MOVE WS-OT-TIER-HOURS TO PAY-OT1-HRS
                   COMPUTE PAY-OT2-HRS = WS-OT-HRS - WS-OT-TIER-HOURS
               ELSE
                   MOVE WS-OT-HRS TO PAY-OT1-HRS
                   MOVE ZERO      TO PAY-OT2-HRS
               END-IF
               COMPUTE WS-RND-IN = WS-RATE * PAY-OT1-HRS * WS-OT1-RATE
               CALL 'PAYRND' USING WS-RND-MODE WS-RND-IN WS-RND-OUT
               MOVE WS-RND-OUT TO PAY-OT1-AMT
               COMPUTE WS-RND-IN = WS-RATE * PAY-OT2-HRS * WS-OT2-RATE
               CALL 'PAYRND' USING WS-RND-MODE WS-RND-IN WS-RND-OUT
               MOVE WS-RND-OUT TO PAY-OT2-AMT
               COMPUTE WS-RND-IN = WS-RATE * WS-HOL-HRS * WS-HOL-RATE
               CALL 'PAYRND' USING WS-RND-MODE WS-RND-IN WS-RND-OUT
               MOVE WS-RND-OUT TO PAY-HOL-AMT
           END-IF
      *    NIGHT PREMIUM IS PAID TO EVERY EMPLOYEE TYPE.
           COMPUTE WS-RND-IN = WS-RATE * WS-NIGHT-HRS * WS-NIGHT-RATE
           CALL 'PAYRND' USING WS-RND-MODE WS-RND-IN WS-RND-OUT
           MOVE WS-RND-OUT TO PAY-NIGHT-AMT.

      *----------------------------------------------------------------*
      * 36-AGREEMENT ALERTS USE THE UNROUNDED MINUTES.                 *
      *----------------------------------------------------------------*
       6000-ALERTS.
           MOVE SPACE TO PAY-ALERT-45 PAY-ALERT-100
           IF NOT EMP-MANAGER
               IF EMP-OT-MIN > WS-LIMIT-45H-MIN
                   SET PAY-OVER-45H TO TRUE
               END-IF
               COMPUTE WS-OT-HOL-MIN = EMP-OT-MIN + EMP-HOL-MIN
               IF WS-OT-HOL-MIN >= WS-LIMIT-100H-MIN
                   SET PAY-AT-100H TO TRUE
               END-IF
           END-IF.

       8000-READ-INPUT.
           READ PAY-IN
               AT END SET END-OF-INPUT TO TRUE
           END-READ.

       9000-TERMINATE.
           DISPLAY 'PAYCALC: PERIOD ' WS-PERIOD ' READ ' WS-READ-CNT
                   ' WRITTEN ' WS-WRITE-CNT ' GROSS ' WS-GROSS-TOTAL
           CLOSE PAY-IN PAY-OUT.
