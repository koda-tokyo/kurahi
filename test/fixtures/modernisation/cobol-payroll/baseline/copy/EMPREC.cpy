      * EMPREC - employee input record (44 bytes, line sequential).
      * Synthetic fixture written for Kurahi. SPDX-License-Identifier: MIT
       01  EMP-REC.
           05  EMP-ID              PIC X(6).
           05  EMP-NAME            PIC X(20).
           05  EMP-HOURS           PIC 9(3)V9.
           05  EMP-RATE            PIC 9(3)V99.
           05  EMP-ADJ             PIC S9(5)V99
                                   SIGN LEADING SEPARATE.
           05  EMP-STATUS          PIC X.
               88  EMP-ACTIVE      VALUE "A".
               88  EMP-ONLEAVE     VALUE "L".
               88  EMP-TERMINATED  VALUE "T".
