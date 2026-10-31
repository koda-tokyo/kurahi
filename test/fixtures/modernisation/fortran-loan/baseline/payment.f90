! PAYMENT - level payment of an annuity (synthetic verification fixture).
! Synthetic fixture written for Kurahi. SPDX-License-Identifier: MIT
double precision function payment(p, r, n)
  implicit none
  double precision, intent(in) :: p, r
  integer, intent(in) :: n
  if (r == 0.0d0) then
    payment = p / n
  else
    payment = p * r / (1.0d0 - (1.0d0 + r) ** (-n))
  end if
  payment = anint(payment * 100.0d0) / 100.0d0
end function payment
