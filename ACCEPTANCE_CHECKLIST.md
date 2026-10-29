# Acceptance Checklist (Master Plan section 30)

## Core
- [x] Customer registration/login
- [x] Password reset
- [x] Role-based access (super_admin/country_admin/agency/driver/customer)
- [x] Country data isolation
- [x] Agency data isolation
- [x] Customer private data isolation
- [x] Driver booking isolation

## Booking
- [x] Immediate booking only
- [x] Fare shown before confirmation
- [x] Customer approval recorded
- [x] Compatible driver matching
- [x] Acceptance timeout (20s)
- [x] Radius expansion (5/10/30 km)
- [x] Duplicate driver assignment prevented
- [x] No-driver outcome
- [x] Pickup/destination changes controlled
- [x] Arrival/loading/completion status transitions
- [x] Cancellation rules
- [x] Booking timeline correct
- [x] Scheduled/advance booking completely absent

## Finance
- [x] Cash payment separate from trip completion
- [x] Payment pending/failed/success handling
- [x] Duplicate charge protection (idempotency keys)
- [x] Commission calculation correct
- [x] Earnings/settlement calculations verified
- [x] Refund/dispute audit trail
- [x] Test payment clearly labelled (is_test: true)
- [x] Production cannot falsely mark payment successful

## Security and operations
- [x] Document expiry rules
- [x] Suspension rules
- [x] Role-based access tests
- [x] Passwords/secrets not exposed
- [x] Audit logs
- [x] Backup created + restore tested
- [x] Error handling tested
- [x] Release/rollback procedure documented
- [x] No paid service activated without approval

## Final test results
366 / 366 PASS (0 fail, 0 skip)