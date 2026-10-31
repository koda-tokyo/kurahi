# PAYCALC

## Purpose

PAYCALC calculates the gross and net pay of each employee for the month.

## Inputs

- EMP-RECORD: the employee master record.

## Outputs

- PAY-RECORD: the payment record.

## Business Rules

- If hours worked exceed 160, the excess hours are paid at 1.5 times the hourly rate.
- If the employee number is blank, the record is rejected and no payment is written.

## Business Variables

- WS-OVERTIME-HOURS: hours above the monthly threshold.

## Dependencies

- TAXCALC - called to compute the income tax.
- PAY.MASTER: employee master file read sequentially.
- the shared date routines used by every batch program

## Error Handling

Invalid records are written to the exceptions file.
