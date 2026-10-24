// Scientific and batch fixture: a fixed-form FORTRAN 77 heat-conduction solver whose units share
// the /GRID/ COMMON block through an include file (one unit declares it by hand, with other
// names), a free-form Fortran 90 module and program, a PL/I rate-posting batch with a record
// structure from %INCLUDE, file I/O, ON-units and EXEC SQL on ACCOUNT and RATE_HIST, the DB2 DDL
// of those tables, a COBOL report on ACCOUNT, a COBOL error logger the PL/I batch calls, and the
// JCL that runs the solver and the batch with their DD statements.

import { A, B, program } from "./helpers.js";

const F = (s: string) => `      ${s}`;
const L = (label: string, s: string) => `${label.padEnd(5)} ${s}`;

export const GRID_CMN = [
  "C     SHARED GRID STATE OF THE HEAT SOLVER",
  F("INTEGER NMAX"),
  F("PARAMETER (NMAX = 1000)"),
  F("INTEGER NX"),
  F("REAL*8 DX, T(NMAX), TNEW(NMAX)"),
  F("COMMON /GRID/ NX, DX, T, TNEW"),
].join("\n");

export const HEATSV_F = [
  "C     HEATSV: 1-D HEAT CONDUCTION BY EXPLICIT FINITE DIFFERENCES",
  "C     READS THE GRID FROM grid.dat AND WRITES THE PROFILE TO profile.out",
  F("PROGRAM HEATSV"),
  F("IMPLICIT NONE"),
  F("INCLUDE 'GRID.CMN'"),
  F("INTEGER ISTEP, NSTEP, I"),
  F("REAL*8 DT, ALPHA, TMAX"),
  F("PARAMETER (NSTEP = 500)"),
  F("OPEN (UNIT=10, FILE='grid.dat', STATUS='OLD')"),
  F("OPEN (UNIT=11, FILE='profile.out', STATUS='NEW')"),
  F("READ (10, *) NX, DX, ALPHA"),
  F("CALL INITT(NX)"),
  F("DT = 0.4D0 * DX * DX / ALPHA"),
  F("DO 100 ISTEP = 1, NSTEP"),
  F("   CALL STEP(DT,"),
  "     &          ALPHA)",
  L("  100", "CONTINUE"),
  F("WRITE (11, 900) (T(I), I = 1, NX)"),
  L("  900", "FORMAT (1X, 5F12.6)"),
  F("CLOSE (10)"),
  F("CLOSE (11)"),
  F("WRITE (*, *) 'PEAK ', TMAX(NX)"),
  F("STOP"),
  F("END"),
].join("\n");

export const STEP_F = [
  "C     ONE EXPLICIT TIME STEP, THE INITIAL PROFILE, THE PEAK AND THE STEP LOG",
  F("SUBROUTINE STEP(DT, ALPHA)"),
  F("IMPLICIT DOUBLE PRECISION (A-H, O-Z)"),
  F("COMMON /GRID/ N, H, T(1000), TNEW(1000)"),
  F("COMMON /STATS/ NCALL"),
  F("DO 10 I = 2, N - 1"),
  F("   TNEW(I) = T(I) + ALPHA*DT/(H*H)*(T(I+1) - 2.0D0*T(I) + T(I-1))"),
  L("   10", "CONTINUE"),
  F("DO 20 I = 2, N - 1"),
  F("   T(I) = TNEW(I)"),
  L("   20", "CONTINUE"),
  F("NCALL = NCALL + 1"),
  F("IF (MOD(NCALL, 100) .EQ. 0) CALL LOGSTP(NCALL)"),
  F("RETURN"),
  F("END"),
  "C",
  F("SUBROUTINE INITT(N)"),
  F("INCLUDE 'GRID.CMN'"),
  F("INTEGER N, I"),
  F("DO 10 I = 1, N"),
  F("   T(I) = 0.0D0"),
  L("   10", "CONTINUE"),
  F("T(1) = 100.0D0"),
  F("RETURN"),
  F("END"),
  "C",
  F("DOUBLE PRECISION FUNCTION TMAX(N)"),
  F("INCLUDE 'GRID.CMN'"),
  F("INTEGER N, I"),
  F("TMAX = T(1)"),
  F("DO 10 I = 2, N"),
  F("   TMAX = MAX(TMAX, T(I))"),
  L("   10", "CONTINUE"),
  F("END"),
  "C",
  F("SUBROUTINE LOGSTP(K)"),
  F("INTEGER K"),
  F("WRITE (12, '(A, I6)') 'STEP ', K"),
  F("GO TO (10, 20), MOD(K, 2) + 1"),
  L("   10", "CONTINUE"),
  L("   20", "RETURN"),
  F("END"),
  "C",
  F("BLOCK DATA STATS0"),
  F("COMMON /STATS/ NCALL"),
  F("DATA NCALL /0/"),
  F("END"),
].join("\n");

export const PHYSICS_F90 = `! Material constants and the diffusivity model of the heat solver
module physics
  use, intrinsic :: iso_fortran_env, only: real64
  implicit none
  integer, parameter :: dp = kind(1.0d0)
  real(kind=dp), parameter :: rho = 7850.0_dp
  real(dp) :: conductivity = 45.0_dp
contains
  pure function diffusivity(cp) result(a)
    real(dp), intent(in) :: cp
    real(dp) :: a
    a = conductivity / (rho * cp)
  end function diffusivity

  subroutine load_material(path)
    character(len=*), intent(in) :: path
    integer :: u, ios
    open(newunit=u, file=path, status='old', &
         action='read', iostat=ios)
    if (ios /= 0) return
    read(u, *) conductivity
    close(u)
  end subroutine load_material
end module physics`;

export const CALIB_F90 = `program calib
  use physics, only: diffusivity, load_material, dp
  implicit none
  real(dp) :: alpha
#ifdef DEBUG
  print *, 'debug build'
#endif
  call load_material('steel.dat')
  alpha = diffusivity(460.0_dp)
  open(unit=20, file='alpha.out', status='replace'); write(20, '(es14.6)') alpha
  close(20)
end program calib`;

export const RATEREC_PLI = ` /* RATE FILE RECORD (80 BYTES) */
 DCL 1 RATE_REC,
       2 R_ACCT    CHAR(10),
       2 R_RATE    FIXED DEC(5,3),
       2 R_EFF     PIC'99999999',
       2 R_FILLER  CHAR(57);`;

export const RATEPOST_PLI = ` /* RATEPOST: POST THE MONTHLY RATES OF THE RATE FILE TO ACCOUNT */
 RATEPOST: PROCEDURE OPTIONS(MAIN);
   %INCLUDE RATEREC;
   DCL RATEIN  FILE RECORD INPUT;
   DCL RPTOUT  FILE STREAM OUTPUT PRINT;
   DCL EOF     BIT(1) INIT('0'B);
   DCL (NREAD, NPOST) FIXED BIN(31) INIT(0);
   DCL WS_BAL  FIXED DEC(11,2);
   DCL P       POINTER;
   DCL 1 HIST  BASED(P),
         2 H_ACCT  CHAR(10),
         2 H_AMT   FIXED DEC(11,2);
   DCL R_KEY   CHAR(10) DEFINED R_ACCT;
   DCL LOGERR  ENTRY(CHAR(80)) EXTERNAL;
   %DCL TRACE CHAR;
   %TRACE = 'N';
   EXEC SQL INCLUDE SQLCA;

   ON ENDFILE(RATEIN) EOF = '1'B;
   ON ERROR BEGIN;
     CALL LOGERR('RATEPOST FAILED');
   END;

   OPEN FILE(RATEIN) INPUT, FILE(RPTOUT) OUTPUT;
   READ FILE(RATEIN) INTO(RATE_REC);
   DO WHILE(^EOF);
     NREAD = NREAD + 1;
     CALL POST_ONE;
     READ FILE(RATEIN) INTO(RATE_REC);
   END;
   %IF TRACE = 'Y' %THEN %DO;
     PUT SKIP LIST('TRACE ON');
   %END;
   PUT FILE(RPTOUT) EDIT('READ ', NREAD, ' POSTED ', NPOST) (A, F(9), A, F(9));
   CLOSE FILE(RATEIN), FILE(RPTOUT);

 POST_ONE: PROC;
   EXEC SQL SELECT BALANCE INTO :WS_BAL FROM ACCOUNT
            WHERE ACCT_NO = :R_ACCT;
   IF SQLCODE = 0 THEN DO;
     WS_BAL = WS_BAL * (1 + R_RATE / 100);
     EXEC SQL UPDATE ACCOUNT SET BALANCE = :WS_BAL
              WHERE ACCT_NO = :R_ACCT;
     EXEC SQL INSERT INTO RATE_HIST (ACCT_NO, RATE, POSTED_ON)
              VALUES (:R_ACCT, :R_RATE, CURRENT DATE);
     NPOST = NPOST + 1;
   END;
   ELSE CALL LOGERR('NO ACCOUNT ' || R_ACCT);
 END POST_ONE;

 END RATEPOST;`;

export const ACCOUNT_DDL = `-- Accounts and rate history (DB2)
CREATE TABLE BANK.ACCOUNT (
  ACCT_NO    CHAR(10)       NOT NULL PRIMARY KEY,
  BALANCE    DECIMAL(11, 2) NOT NULL,
  OPENED_ON  DATE
);

CREATE TABLE BANK.RATE_HIST (
  ACCT_NO    CHAR(10)      NOT NULL REFERENCES BANK.ACCOUNT (ACCT_NO),
  RATE       DECIMAL(5, 3) NOT NULL,
  POSTED_ON  DATE          NOT NULL
);
`;

export const ACCTRPT = program("ACCTRPT", {
  data: [A("WORKING-STORAGE SECTION."), A("01  WS-BAL PIC S9(9)V99 COMP-3.")],
  proc: [
    A("0000-MAIN."),
    B("EXEC SQL SELECT SUM(BALANCE) INTO :WS-BAL FROM ACCOUNT END-EXEC"),
    B("STOP RUN."),
  ],
});

export const LOGERR = program("LOGERR", {
  data: [A("LINKAGE SECTION."), A("01  LK-MSG PIC X(80).")],
  using: "LK-MSG",
  proc: [
    A("0000-MAIN."),
    B("EXEC SQL INSERT INTO ERR_LOG (MSG) VALUES (:LK-MSG) END-EXEC"),
    B("GOBACK."),
  ],
});

export const HEATRUN_JCL = [
  "//HEATRUN  JOB (SCI),'HEAT AND RATES'",
  "//S10      EXEC PGM=HEATSV",
  "//FT12F001 DD DSN=SCI.HEAT.STEPLOG,DISP=(NEW,CATLG)",
  "//S20      EXEC PGM=RATEPOST",
  "//RATEIN   DD DSN=BANK.RATES.MONTHLY,DISP=SHR",
  "//RPTOUT   DD SYSOUT=*",
].join("\n");

export const SCI_FILES: Record<string, string> = {
  "fortran/HEATSV.f": HEATSV_F,
  "fortran/STEP.f": STEP_F,
  "fortran/GRID.CMN": GRID_CMN,
  "fortran/physics.f90": PHYSICS_F90,
  "fortran/calib.f90": CALIB_F90,
  "pli/RATEPOST.pli": RATEPOST_PLI,
  "pli/RATEREC.plinc": RATEREC_PLI,
  "db/account.sql": ACCOUNT_DDL,
  "cobol/ACCTRPT.cbl": ACCTRPT,
  "cobol/LOGERR.cbl": LOGERR,
  "jcl/HEATRUN.jcl": HEATRUN_JCL,
};
