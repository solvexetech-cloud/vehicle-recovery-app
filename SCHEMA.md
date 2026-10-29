# Database Schema (Phase 2)

All tables use `INTEGER PRIMARY KEY AUTOINCREMENT`. Timestamps are ISO-8601 UTC TEXT.
Money is INTEGER minor units (fils). Foreign keys enforced (`PRAGMA foreign_keys = ON`).

## Tables

| Table | Purpose |
|---|---|
| countries | GCC countries with currency, timezone, dial code, is_active |
| users | All roles (super_admin/country_admin/agency/driver/customer), unique email |
| agencies | Recovery agencies, linked to a user + country, approval status |
| recovery_vehicles | Tow/flatbed/etc., linked to agency, expiry dates for insurance/inspection |
| drivers | Driver profile linked to user + agency + current vehicle, GPS + online status |
| customer_vehicles | Customer's saved vehicles, category snapshot |
| bookings | Immediate bookings only, fare snapshot, status machine, cancellation |
| booking_status_history | Immutable timeline of status transitions with actor |
| payments | One per (booking, method), idempotency_key for safe retries |
| payment_events | Append-only payment event log |
| audit_logs | All sensitive actions, scoped by country + entity |
| sessions | Auth sessions (Phase 3 uses this) |
| password_reset_tokens | Single-use hashed reset tokens |
| idempotency_keys | Idempotency for booking + payment endpoints |
| schema_migrations | Applied migration filenames |
| _meta | App metadata (schema_version) |

## Booking statuses (CHECK)
created, searching, assigned, driver_accepted, driver_on_way,
driver_arrived, vehicle_loaded, trip_in_progress, trip_completed,
cancelled, no_driver_available,
payment_pending, payment_completed, payment_failed, disputed

Scheduled/advance bookings are intentionally absent (Immediate Booking Only).
## Phase 4.1 additions

| Table | Purpose |
|---|---|
| country_settings | Per-country config: tax, cancellation, dispatch, privacy, invoice, languages |
| country_services | 8 services per country with is_enabled, base_fare_minor, per_km_minor, etc. |

Both are auto-seeded on first boot via ensureCountryConfig.
Country settings use INSERT OR IGNORE; QA-specific service defaults applied only once.
## Phase 5.1 additions

| Table | Purpose |
|---|---|
| customer_destinations | Saved destinations (label, address, lat, lng, optional contact) |

country_settings gained:
- max_saved_vehicles INTEGER NOT NULL DEFAULT 5
- max_saved_destinations INTEGER NOT NULL DEFAULT 10
## Phase 5.2 additions

| Table | Purpose |
|---|---|
| driver_documents | Driver ID/licence/permit uploads with mime, size, expiry, review status |
| driver_vehicles | Authorization link (driver_id, recovery_vehicle_id, revoked_at) |
## Phase 5.3 additions

No new tables. Migration 007 only adds supporting indexes:
- ix_driver_vehicles_by_vehicle (recovery_vehicle_id, revoked_at)
- ix_recovery_vehicles_status (status, country_id)
## Phase 6.1 additions

No new tables. Uses existing:
- bookings (with fare_estimate_json, customer_vehicle_snapshot_json, agreed_fare_minor)
- booking_status_history (written at creation: created)
- idempotency_keys (scope='booking.create')
## Phase 6.2 additions

| Table | Purpose |
|---|---|
| dispatch_offers | One row per offered driver (booking_id, driver_id, round, radius, distance, response, expires_at) |

Partial unique indexes:
- ux_dispatch_offers_pending_booking (one pending offer per booking at a time)
- ux_dispatch_offers_pending_driver  (one pending offer per driver at a time)
## Phase 9 additions

| Table | Purpose |
|---|---|
| support_tickets | Support tickets (creator, category, subject, description, status, assignee) |
| ticket_messages | Messages thread per ticket |
| chat_messages | Booking-scoped chat (customer <-> driver) |
| notifications | Per-user in-app notification feed with data_json |