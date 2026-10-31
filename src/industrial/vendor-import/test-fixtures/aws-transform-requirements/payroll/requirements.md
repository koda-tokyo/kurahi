# Payroll calculation: monthly gross-to-net workflow

## Global preconditions

- The employee master file is available and current for the pay period.
- The tax table version is set by the parameter {TAX_TABLE_VERSION}.

## 1. Validate employee pay data

**User story:** As a payroll clerk, I want each employee record validated before calculation, so that no payment is made from incomplete data.

### Requirements

- REQ-1.1: When an employee record is read, the system shall reject the record if the employee number is blank.
- REQ-1.2: If the pay grade is not in the grade table, then the system shall write the record to the exceptions file.

## 2. Calculate net pay

**User story:** As a payroll manager, I want net pay calculated with the current tax table, so that employees are paid correctly.

### Requirements

- REQ-2.1: The system shall compute gross pay as base salary plus approved overtime.
- REQ-2.2: While the pay period is a bonus month, the system shall add the bonus amount to gross pay.
- REQ-2.3: Where the employee has opted into the pension plan, the system shall deduct the pension contribution before tax.
