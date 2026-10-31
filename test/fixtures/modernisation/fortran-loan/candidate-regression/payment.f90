! PAYMENT - level payment of an annuity (synthetic verification fixture).
! Synthetic fixture written for Kurahi. SPDX-License-Identifier: MIT
! INJECTED REGRESSION: the discount factor is computed in single precision.
double precision function payment(p, r, n)
  implicit none
  double precision, intent(in) :: p, r
  integer, intent(in) :: n
  real :: discount
  if (r == 0.0d0) then
    payment = anint(p / n * 100.0d0) / 100.0d0
    return
  end if
  discount = 1.0 - (1.0 + real(r)) ** (-n)
  payment = anint(p * r / discount * 100.0d0) / 100.0d0
end function payment
