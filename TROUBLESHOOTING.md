# Troubleshooting Guide

## Server won't start

| Error | Fix |
|---|---|
| EADDRINUSE | Port busy. `$env:PORT="3001"; npm start` |
| Cannot find module | `npm install` |
| SQLITE_CANTOPEN | `New-Item -ItemType Directory data` |
| Migration failed | Delete `data/app.db*` and restart |

## Tests fail

    npm test 2>&1 | Out-File test-output.txt
    Get-Content test-output.txt | Select-String "test at tests|AssertionError" -Context 0,5

Common causes: stale dev DB, Node < 22.5, time-based flake.

## Login fails

| Error | Fix |
|---|---|
| invalid_credentials | Check email/password case |
| email_not_verified | Verify via dev_verify_token from register response |
| account_suspended | Admin must unsuspend |
| mfa_required | Add mfa_code field to login body |
| rate_limited | Wait 15 minutes |

## Booking fails

| Error | Fix |
|---|---|
| service_not_enabled | Admin enable in country_services |
| agreed_fare_mismatch | Re-fetch estimate; must match exactly |
| no_driver | All eligible drivers busy; retry dispatch |
| booking_not_searching | Already assigned or cancelled |

## Notifications missing

- Check GET /api/customer/notifications
- Verify kind values: booking.assigned, booking.trip_completed,
  payment.cash_paid, chat.message, dispute.opened, ticket.created
- TD-099 fixed Phase 11 (verified by tests/notifications11.test.js)