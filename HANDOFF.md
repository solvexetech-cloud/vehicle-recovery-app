# Vehicle Recovery App - Handoff (Malayalam)

> v1.0.0 | 366 tests passing | 10 migrations | 28 tables | 0 paid services

## 1. Run locally

Requirements: Windows 10/11, Node.js v22.5+ (already have v26.8.1), npm.

    cd C:\Users\DELL\Documents\VehicleRecoveryApp
    npm install
    npm start

Open in browser:
- http://localhost:3000/         - UI (login/register/dashboards)
- http://localhost:3000/health   - JSON health

Dev super admin:
- Email: superadmin@vra.local
- Password: ChangeMe-Admin-2026!

## 2. Run tests

    npm test

Expected: 366 tests / 366 pass / 0 fail (about 15 seconds)

## 3. UI usage

Customer: Register (role=customer) -> verify email -> login -> customer.html -> add vehicle -> new recovery -> estimate -> book -> dispatch -> track -> pay.

Driver: Register (role=driver) -> verify -> upload doc -> set vehicle -> go online -> driver.html -> accept offers -> trip actions.

Admin: super admin login -> admin.html -> countries, analytics, reports, CSV export.
## 4. Backup

    .\scripts\backup.ps1

Creates data/backups/app-YYYYMMDD-HHMMSS.db, keeps latest 7.

Restore:

    .\scripts\restore.ps1 -BackupFile data\backups\app-YYYYMMDD-HHMMSS.db

Stop server before restore.

## 5. Database

Location: data/app.db (SQLite, WAL mode)
Tables: 28 (see SCHEMA.md)
Reset (destructive): Remove-Item data\app.db, data\app.db-wal, data\app.db-shm then npm start

## 6. Git

    git log --oneline
    git status
    git add -A
    git commit -m "Phase X: summary"

## 7. Troubleshooting

Server won't start: port 3000 busy -> $env:PORT="3001"; npm start
Tests fail: npm test 2>&1 | Select-String "test at tests|AssertionError" -Context 0,3
Login fails: email_not_verified -> verify via dev token from register response

## 8. Known limitations (v1.0.0)

- Real email delivery: deferred (dev returns token in response)
- Push notifications: deferred (in-app feed works)
- Live map: deferred (haversine distance)
- Payment gateway: deferred (test-mode online works)
- Bank payout: deferred (manual workflow)
- Arabic RTL UI: deferred (i18n scaffolding ready)
- Scheduled bookings: never (immediate-only policy)

## 9. Production deployment

See DEPLOYMENT.md.

Before production:
- NODE_ENV=production
- SEED_SUPER_ADMIN_PASSWORD unset
- MFA_REQUIRED_FOR_SUPER_ADMIN=true
- HTTPS reverse proxy
- Backup cron scheduled
- Monitor /health + [notify] errors

## 10. Files of interest

- MASTER_PLAN_STATUS.md - phase tracking
- TECHNICAL_DECISIONS.md - TD-001 to TD-107
- SCHEMA.md - database schema
- DEPLOYMENT.md - hosting guide
- api-demo.http - VS Code REST Client demo
- README.md - quick reference

App built with 0 QAR total spend. No paid services activated.
