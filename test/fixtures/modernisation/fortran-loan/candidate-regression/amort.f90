! AMORT - loan amortisation summary (synthetic verification fixture).
! Synthetic fixture written for Kurahi. SPDX-License-Identifier: MIT
! Reads principal, annual rate and months from stdin; prints the level
! payment, total interest and the balance after each 12th payment.
program amort
  implicit none
  double precision :: principal, annual, pay, bal, interest, total
  double precision, external :: payment
  integer :: months, i, ios
  read (*, *, iostat=ios) principal, annual, months
  if (ios /= 0 .or. months <= 0) then
    write (*, '(A)') 'INVALID INPUT'
    stop 2
  end if
  pay = payment(principal, annual / 12.0d0, months)
  write (*, '(A, F14.2)') 'PAYMENT   ', pay
  bal = principal
  total = 0.0d0
  do i = 1, months
    interest = anint(bal * annual / 12.0d0 * 100.0d0) / 100.0d0
    total = total + interest
    bal = bal + interest - pay
    if (mod(i, 12) == 0 .or. i == months) then
      write (*, '(A, I4, F14.2)') 'BALANCE ', i, bal
    end if
  end do
  write (*, '(A, F14.2)') 'INTEREST  ', total
end program amort
