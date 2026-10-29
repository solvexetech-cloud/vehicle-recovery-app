# Vehicle Recovery App

On-demand vehicle recovery platform. Immediate booking only.
Multi-country ready, local-first, zero-cost development.

## Status

- Phase 1.2 - Skeleton + smoke tests
- Phase 2   - Database schema, migrations, seeding, logging, errors
- Phase 3.1 - Authentication (register, verify, login, logout, RBAC, rate limit, audit)
- Phase 3.2 - Password reset, resend verification, session management, admin force-logout
- Phase 4.1 - Country configuration + Super Admin CRUD
- Phase 4.2 - Country Admin scoped endpoints + MFA TOTP
- Phase 5.1 - Customer profile + saved vehicles + saved destinations
- Phase 5.2 - Driver profile + online + GPS + documents + eligibility
- Phase 5.3 - Agency profile + fleet + driver authorization
- Phase 6.1 - Immediate booking: fare estimate + booking creation (idempotent)
- Phase 6.2 - Atomic dispatch: offers, accept/reject, timeout, radius expansion
- Phase 7   - Trip operations + live tracking + cancellation with country policy
- Phase 8   - Payments: cash flow, test-mode online, dispute (real gateway deferred)
- Phase 9   - Support tickets + in-app chat + notifications + dispute resolution

## Requirements
- Node.js v22.5+ (built-in node:sqlite)
- npm (bundled)

## Setup
    cd C:\Users\DELL\Documents\VehicleRecoveryApp
    npm install

## Run
    npm start

- App:    http://localhost:3000
- Health: http://localhost:3000/health

## Dev super admin (auto-seeded once)
- Email:    superadmin@vra.local
- Password: ChangeMe-Admin-2026!  (override via SEED_SUPER_ADMIN_PASSWORD)

## API (highlights)

### Auth / MFA / Sessions
(unchanged from Phase 4.2)

### Public
- GET  /api/countries

### Customer (/api/customer)  -- role: customer
- GET    /api/customer/profile
- PATCH  /api/customer/profile           { full_name?, phone? }
- GET    /api/customer/vehicles
- POST   /api/customer/vehicles          { category, registration_number, make?, model?, colour?, is_default? }
- PATCH  /api/customer/vehicles/:id
- POST   /api/customer/vehicles/:id/default
- DELETE /api/customer/vehicles/:id
- GET    /api/customer/destinations
- POST   /api/customer/destinations      { label, address, lat, lng, contact_phone? }
- PATCH  /api/customer/destinations/:id
- DELETE /api/customer/destinations/:id

### Driver (/api/driver)  -- role: driver
- GET    /api/driver/profile
- PATCH  /api/driver/profile           { full_name?, phone? }
- GET    /api/driver/vehicles          -> authorized recovery vehicles
- POST   /api/driver/current-vehicle   { recovery_vehicle_id }
- POST   /api/driver/status            { is_online }
- POST   /api/driver/location          { lat, lng }
- GET    /api/driver/documents
- POST   /api/driver/documents         { doc_type, data_url, expires_at? }   (base64, 2 MB max)
- DELETE /api/driver/documents/:id
- GET    /api/driver/eligibility       -> { eligible, reasons, snapshot }

### Customer Bookings dispatch
- POST /api/customer/bookings/:id/dispatch          starts/advances dispatch
- POST /api/customer/bookings/:id/dispatch/advance  sweeper (expire + advance)

### Driver Trip Operations (/api/driver/bookings)  -- role: driver
- GET  /api/driver/bookings/active        -> current trip or null
- POST /api/driver/bookings/:id/on-way
- POST /api/driver/bookings/:id/arrived   { manual_fallback?, reason? }
- POST /api/driver/bookings/:id/loaded
- POST /api/driver/bookings/:id/start-trip
- POST /api/driver/bookings/:id/complete
- POST /api/driver/bookings/:id/cancel    { reason }

### Customer Payments (/api/customer/bookings)  -- role: customer
- GET  /api/customer/bookings/:id/payment               -> status + rows + events
- POST /api/customer/bookings/:id/payment/cash-paid     { amount_minor? }  [Idempotency-Key]
- POST /api/customer/bookings/:id/payment/online/test   { amount_minor? }  [Idempotency-Key]  (blocked in prod)
- POST /api/customer/bookings/:id/payment/online/test/confirm
- POST /api/customer/bookings/:id/payment/dispute       { reason }

### Customer Support (/api/customer)  -- role: customer
- POST/GET /api/customer/tickets
- GET  /api/customer/tickets/:id
- POST /api/customer/tickets/:id/messages
- GET  /api/customer/notifications[?unread=1]
- POST /api/customer/notifications/:id/read
- POST /api/customer/notifications/read-all
- GET/POST /api/customer/bookings/:id/chat

### Driver Support (/api/driver)  -- role: driver
- POST/GET /api/driver/tickets
- GET  /api/driver/tickets/:id
- POST /api/driver/tickets/:id/messages
- GET  /api/driver/notifications[?unread=1]
- POST /api/driver/notifications/:id/read
- POST /api/driver/notifications/read-all
- GET/POST /api/driver/bookings/:id/chat

### Admin Support (/api/admin)  -- role: country_admin | super_admin
- GET  /api/admin/tickets[?status=...]
- GET  /api/admin/tickets/:id
- POST /api/admin/tickets/:id/assign      { assigned_to_user_id }
- POST /api/admin/tickets/:id/status      { status }
- POST /api/admin/tickets/:id/resolve     { resolution_note }
- POST /api/admin/tickets/:id/messages    { body }
- POST /api/admin/bookings/:id/payment/resolve-dispute  { target_status, resolution_note }

### Driver Payments (/api/driver/bookings)  -- role: driver
- POST /api/driver/bookings/:id/payment/cash-received   { amount_minor? }
- POST /api/driver/bookings/:id/payment/dispute         { reason }

### Customer Tracking + Cancel
- GET  /api/customer/bookings/:id/tracking
- POST /api/customer/bookings/:id/cancel   { reason? }

### Driver Bookings (/api/driver/bookings)  -- role: driver
- GET  /api/driver/bookings/incoming        -> live offer or null
- POST /api/driver/bookings/:id/accept      -> 200 assigned or 409 lost_race/expired
- POST /api/driver/bookings/:id/reject      -> 200 advanced (next candidate info)

### Customer Bookings (/api/customer/bookings)  -- role: customer
- POST /api/customer/bookings/estimate   { service_type, service_level?, pickup{lat,lng,address?}, destination{lat,lng,address?}, vehicle_id? OR vehicle{category,registration_number,...} }
- POST /api/customer/bookings            same shape + agreed_fare_minor (from estimate)   [Idempotency-Key header supported]
- GET  /api/customer/bookings            -> own list (last 100)
- GET  /api/customer/bookings/:id        -> own booking + history + snapshots

### Agency (/api/agency)  -- role: agency
- GET    /api/agency/profile
- PATCH  /api/agency/profile                { display_name?, legal_name?, contact_email?, contact_phone? }
- GET    /api/agency/vehicles
- POST   /api/agency/vehicles               { vehicle_type, plate_number, make?, model?, year?, insurance_expires_at?, inspection_expires_at? }
- PATCH  /api/agency/vehicles/:id           (status field forbidden)
- DELETE /api/agency/vehicles/:id           (blocked if referenced)
- GET    /api/agency/drivers                -> own drivers + authorizations
- POST   /api/agency/drivers/:driverId/authorize  { recovery_vehicle_id }
- DELETE /api/agency/drivers/:driverId/vehicles/:vehicleId

### Country Admin (/api/admin)  -- role: country_admin
(unchanged from Phase 4.2)

### Super Admin (/api/super)  -- role: super_admin
(unchanged from Phase 4.2)

## Test
    npm test

## Notes
- Paid services are not activated.
- Local development only.
- See TECHNICAL_DECISIONS.md, SCHEMA.md.
## Backup and Restore

Backup the SQLite database:

    .\scripts\backup.ps1

Restore from a backup:

    .\scripts\restore.ps1 -BackupFile data\backups\app-YYYYMMDD-HHMMSS.db

Retention: last 7 backups kept automatically.

## Deployment

See `DEPLOYMENT.md` for free-tier hosting options and production checklist.

## Phase status

See `MASTER_PLAN_STATUS.md` for the current phase and known gaps.

## Environment variables

See `.env.example` for all config options.
