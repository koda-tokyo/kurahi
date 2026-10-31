# Payroll application

## Overview

The payroll application calculates monthly pay for employees and writes the payment file.

## Processing Flow

PAYJOB runs PAYCALC, which calls TAXCALC for each employee.

## Components

- PAYCALC: calculates gross and net pay.
- TAXCALC: computes the income tax for one employee.

## Business Rules

- Overtime is paid at 1.5 times the hourly rate above 160 hours per month.
- An employee with a blank employee number is not paid.

## Inputs

- Employee master file (PAY.MASTER).

## Outputs

- Payment file.
