# Technical Decisions Log

## TD-001: Runtime - Node.js (user has v26.8.1)
Reason: already installed. Free.

## TD-002: Backend framework - Express 4
Reason: mature, minimal, beginner-friendly.

## TD-003: Database - built-in node:sqlite (DatabaseSync)
Reason:
- Available in Node 22.5+, no npm install.
- Avoids native module compilation risk (better-sqlite3) on Node 26.
- Single-file SQLite with WAL. Easy backup.
Fallback: better-sqlite3 (needs build tools) or lowdb (JSON).

## TD-004: Frontend - Vanilla HTML/CSS/JS (Phase 2+)
Reason: no build step, beginner-friendly. Served from public/.

## TD-005: Env vars - dotenv + .env
Reason: standard, free, .env gitignored.

## TD-006: Tests - built-in node:test
Reason: no extra dependency.

## TD-007: Language - English code, Malayalam instructions
Reason: per master plan section 1.

## TD-008: Booking model - Immediate only
Reason: per master plan section 3. No scheduled/advance booking anywhere.

## Deferred (future phases)
- Auth (JWT)        -> Phase 3
- Maps              -> Phase 6 (mock first)
- Payments          -> Phase 8 (cash + test-mode only)
- i18n EN/AR + RTL  -> Phase 10
## TD-009 (Phase 2): Migrations
Plain SQL files in src/migrations/, tracked in schema_migrations.
Idempotent (re-run => 0 applied). Wrapped in BEGIN IMMEDIATE / COMMIT.

## TD-010 (Phase 2): Money type
INTEGER minor units. Avoids float rounding. All stored in payment/fare columns.

## TD-011 (Phase 2): Structured logging
JSON lines, level-based, silent via LOG_LEVEL=silent in tests.

## TD-012 (Phase 2): Errors
AppError class + central handler. Non-AppError becomes generic 500.

## TD-013 (Phase 2): Countries seed via JS
src/seed.js with \u escapes for Arabic, INSERT OR IGNORE for idempotency.
Qatar is_active=1 in dev; others 0. Flip via admin later.
## TD-014 (Phase 3.1): Password hashing - node:crypto scrypt
Reason: zero npm, secure, timing-safe. N=16384, r=8, p=1.
Format: scrypt$N$r$p$salt_b64$hash_b64. Sync variant only used for dev admin seed.

## TD-015 (Phase 3.1): Sessions over JWT
Reason: DB-backed => revocable (JWT cannot be revoked without blacklist).
Cookie vra_sess: HttpOnly, SameSite=Lax, Secure in prod, path=/.
Role TTL: customer/driver/agency 7d, country_admin 12h, super_admin 4h.

## TD-016 (Phase 3.1): No paid email in dev
Email verification token returned as dev_verify_token only when NODE_ENV != production.
Token stored as SHA-256 hash; expires 24h; single-use.

## TD-017 (Phase 3.1): Login rate limit
In-memory Map keyed by normalized identifier. 5 attempts / 15 min => 409.
No external dep. Move to DB-backed if multi-process needed later.

## TD-018 (Phase 3.1): Dev super admin seed
Auto-seeded once if no super_admin exists AND NODE_ENV != production.
Email superadmin@vra.local. Password from SEED_SUPER_ADMIN_PASSWORD or default (logged once).
NEVER seeded in production.
## TD-019 (Phase 3.2): Password reset tokens
Stored as SHA-256 hash in password_reset_tokens, TTL 1h, single-use.
One active reset token per user: creating new one marks old ones used_at.
Dev returns dev_reset_token only when NODE_ENV != production.

## TD-020 (Phase 3.2): Resend-verification invalidates old tokens
Same pattern as reset: only latest verification token works.
60-second cooldown per email (in-memory map) to prevent abuse.
Unknown/pending-or-wrong email returns {ok:true} to avoid enumeration.

## TD-021 (Phase 3.2): Change-password session policy
Requires current_password verification. Revokes all OTHER sessions, keeps current.
Reset-password (via token) revokes ALL sessions because identity was proven by token only.

## TD-022 (Phase 3.2): Session management endpoints
GET /api/auth/sessions returns own active sessions with current_session_id.
DELETE /api/auth/sessions/:id is user-scoped (WHERE user_id = req.user.id).
Cross-user access returns 404 (not 403) to avoid existence leak.

## TD-023 (Phase 3.2): Admin force-logout scoping
super_admin: can target any user (including themselves).
country_admin: can target self OR same-country non-admin users.
Cross-country targets and admin-to-admin targets return 403.
Every force-logout writes to audit_logs with revoked count.
## TD-024 (Phase 4.1): Country config normalization
Two tables: country_settings (1 row per country) + country_services (8 rows per country, one per service).
Rationale: fixed columns for global config, per-service pricing rows for scaling to new services.

## TD-025 (Phase 4.1): ensureCountryConfig idempotency
INSERT OR IGNORE for both tables. QA dev defaults (towing + jump_start enabled) applied ONLY
when the settings row is new (wasCreated=true). Admin changes are never overwritten on boot.

## TD-026 (Phase 4.1): Country admin creation by super admin
Super admin sets initial password (dev flow). Account created active with email_verified_at set.
Future: replace with email-invite flow + forced password change on first login.

## TD-027 (Phase 4.1): Super Admin endpoints under /api/super/*
All /api/super/* routes guarded by requireRole('super_admin').
/api/admin/* remains for country_admin scoped actions.
Semantic split keeps future auditing and rate limiting easier.

## TD-028 (Phase 4.1): Country_services composite PK
PRIMARY KEY (country_id, service_code) - ensures one pricing row per (country, service) pair.
No separate id column needed.

## TD-029 (Phase 4.1): MFA deferred
Super-admin MFA (TOTP) planned for Phase 4.2 or Phase 5.
TOTP will use node:crypto HMAC-SHA1 with RFC 6238 (zero deps).
No paid third-party.
## TD-030 (Phase 4.2): Country admin country-scoped endpoints
GET /api/admin/country returns ONLY the caller's country + settings + services.
PATCH endpoints operate on req.user.country_id exclusively.
Any `country_id` in the body is rejected with 403 cross_country_forbidden + audited.

## TD-031 (Phase 4.2): TOTP (RFC 6238) via node:crypto
Zero external dependencies. HMAC-SHA1, 30s period, 6 digits, window=1 accepted.
Secret = base32 of 20 random bytes (160 bits, per RFC 4226).
otpauth:// URL for any TOTP app (Google Authenticator, Authy, 1Password).
Tested against RFC 6238 official test vectors.

## TD-032 (Phase 4.2): MFA enrollment flow
POST /mfa/enroll  -> secret saved in mfa_secret, mfa_enabled=0, response includes secret+url
POST /mfa/confirm -> verify current code (window 1), set mfa_enabled=1
POST /mfa/disable -> requires password, clears mfa_secret + mfa_enabled, revokes other sessions
Re-enroll while pending -> regenerates. Re-enroll while enabled -> 409.

## TD-033 (Phase 4.2): Login with MFA
Login flow order:
  1. rate-limit + recordAttempt
  2. password verify
  3. status check
  4. super_admin MFA policy (optional via MFA_REQUIRED_FOR_SUPER_ADMIN)
  5. if mfa_enabled: require mfa_code; verify with window=1
  6. clearAttempts + createSession
Wrong mfa_code does NOT clear rate limit â€” protects against brute-force.

## TD-034 (Phase 4.2): MFA_REQUIRED_FOR_SUPER_ADMIN config
Default false in dev (config flag). When true:
  - boot warns if super admin has no MFA enrolled
  - login blocks super admin with mfa_setup_required
Flip to true when ready for prod enforcement (Phase 5+).

## TD-035 (Phase 4.2): No new migration in this phase
mfa_secret + mfa_enabled were added in migration 002.
Backup codes deferred to future phase (mfa_backup_codes table).
Known limitation: user who loses TOTP device cannot log in. Admin reset planned for Phase 5.
## TD-036 (Phase 5.1): Customer profile route under /api/customer
requireRole('customer') guards the whole router.
Country_admin / driver get 403 (tested).

## TD-037 (Phase 5.1): Saved vehicle default policy
First vehicle auto-becomes default (is_default=1).
POST /vehicles with is_default=true unsets any existing default first.
POST /vehicles/:id/default endpoint atomically toggles.
Delete of default promotes the oldest remaining vehicle.

## TD-038 (Phase 5.1): Registration number required
For Phase 5.1 we require registration_number 1-20 chars for all customer vehicles.
Future: country_settings could set per-country required/optional.

## TD-039 (Phase 5.1): Limits enforced per country
country_settings.max_saved_vehicles (default 5) and .max_saved_destinations (default 10).
Exceeding limit -> 409 conflict with { limit } in details.

## TD-040 (Phase 5.1): Isolation returns 404
Customer B attempting to access Customer A's row -> 404 not_found.
Rationale: prevents existence leak (same id-unknown pattern as session revoke).

## TD-041 (Phase 5.1): Destination lat/lng required
Both required, validated ranges (-90..90, -180..180). No geocoding in 5.1.
Booking phase will use these coordinates directly.

## TD-042 (Phase 5.1): No photo upload yet
customer_vehicles.photo_path exists from migration 001.
Phase 5.2 will add base64 upload with size/mime validation (no paid storage).
## TD-043 (Phase 5.2): Driver documents stored on local filesystem
Path: data/uploads/driver_<id>/<random-hex>.<ext>
Mime whitelist: image/jpeg, image/png, application/pdf.
Max: 2 MB per file (config.driverDocMaxBytes).
Review status starts pending; admin approval (Phase 4 admin routes) flips to approved.

## TD-044 (Phase 5.2): driver_vehicles = authorization link
Agency (or admin) inserts driver_vehicles (driver_id, recovery_vehicle_id) to authorize.
Driver can only select current_vehicle_id from this whitelist.
Phase 5.3 will add agency-side endpoints to manage these authorizations.

## TD-045 (Phase 5.2): Eligibility is evaluated, not stored
evaluateEligibility() runs on demand. Composite checks:
- driver.status == approved
- user.status == active
- agency.status == approved (if agency set)
- driving_license document approved + not expired
- current_vehicle_id approved + authorized + belongs to agency
- GPS fresh (< 5 minutes)
- is_online

## TD-046 (Phase 5.2): Going online requires eligibility except online itself
POST /api/driver/status { is_online: true } checks eligibility but ignores 'driver_offline' reason.
Resulting blocking reasons (if any) returned in error message prefixed with 'not_eligible_online:'.

## TD-047 (Phase 5.2): GPS freshness window
GPS_FRESH_MS = 5 minutes (constant in src/driver/eligibility.js).
Future: per-country configuration (country_settings.driver_gps_fresh_seconds).

## TD-048 (Phase 5.2): Isolation returns 404
Driver A cannot delete/see Driver B document -> 404 (same pattern as customer isolation).
Cross-agency vehicle selection returns 403 (agency_scope violation, explicit).

## TD-049 (Phase 5.2): JSON body limit raised to 4 MB
Base64 data URLs inflate ~33%, so 2 MB file = ~2.7 MB base64 payload.
4 MB gives safe headroom for the largest allowed doc.

## TD-050 (Phase 5.2): Test provisioning via DB
Tests insert agency + driver + vehicle + authorization directly through db handle.
Public admin endpoints for agency management come in Phase 5.3.
## TD-051 (Phase 5.3): Agency routes under /api/agency
requireRole('agency') on router. Only own rows visible/modifiable.
Suspended/rejected agencies: profile PATCH and vehicle add blocked (403), but profile GET works.

## TD-052 (Phase 5.3): Vehicle status changes are admin-only
Agency PATCH /api/agency/vehicles/:id rejects 'status' field with 403.
Newly created vehicles default to status='pending' (Country Admin approves in later phase).

## TD-053 (Phase 5.3): Vehicle deletion safety
Blocked if:
- Any active driver_vehicles link (409 with count)
- Any bookings reference it (409 with count)
- Any driver.current_vehicle_id points at it (409 with count)
No soft-delete column in recovery_vehicles â€” hard delete once safe.

## TD-054 (Phase 5.3): Authorization = soft toggle
driver_vehicles unique PK (driver_id, recovery_vehicle_id).
POST /authorize:
  - New row -> 201
  - Existing active row -> 200 { already_authorized: true }
  - Existing revoked row -> reactivate (set revoked_at=NULL)
DELETE /revoke -> set revoked_at, clears driver.current_vehicle_id if match.

## TD-055 (Phase 5.3): Agency cannot authorize pending/rejected vehicles
Only approved vehicles can be authorized by agency. Ensures admin approval chain.

## TD-056 (Phase 5.3): Plate number unique per country
recovery_vehicles has UNIQUE(country_id, plate_number) from migration 001.
Agency adding vehicle checks this and returns 409 conflict.
Plate change also checks (excluding self).

## TD-057 (Phase 5.3): Agency driver visibility limited to own drivers
GET /api/agency/drivers JOINs drivers WHERE agency_id = agency.id.
Cross-agency authorize/revoke returns 404 (not 403) to avoid existence leaks.
## TD-058 (Phase 6.1): Fare computed server-side only
Client cannot send a computed fare; server computes from country_settings + country_services.
Customer sends agreed_fare_minor = total_minor returned by estimate.
Mismatch -> 422 (agreed_fare_mismatch with details) â€” prevents client tampering.

## TD-059 (Phase 6.1): Distance = haversine (great-circle)
No external map/router in free dev. Phase 6.x could swap in OSRM route distance.
Earth radius 6371 km. Rounded to 2 decimals for storage.

## TD-060 (Phase 6.1): Fare formula
subtotal = base + per_km * distance_km + fast_surcharge
if subtotal < min_fare -> subtotal = min_fare
tax = round(subtotal * tax_rate_bp / 10000)
total = subtotal + tax
All integer minor units. No floating point across DB boundary.

## TD-061 (Phase 6.1): Cancellation policy snapshot
Estimate returns { fee_minor, free_cancel_seconds }.
Stored in fare_estimate_json at booking creation so future policy changes don't retroactively apply.
Phase 7 will enforce on cancel.

## TD-062 (Phase 6.1): Immediate-only enforced at API boundary
Request body containing scheduled_at / scheduled_time / booking_time / future_date -> 422.
No schema fields for scheduling (per master plan section 3).

## TD-063 (Phase 6.1): Idempotency via Idempotency-Key header
Scope 'booking.create'. Body hashed with SHA-256.
Same key + same body -> return stored response (200).
Same key + different body -> 409.
Reusable via idempotency_keys table (already in migration 001).

## TD-064 (Phase 6.1): Booking number format
BK-YYYYMMDD-<8 hex chars uppercase>. Collision retry loop (5 attempts) inside transaction.
Future: HMAC short code for anti-guessing (Phase 10).

## TD-065 (Phase 6.1): Booking starts in 'created' status
Status history row written atomically in same transaction.
Phase 6.2 dispatch transitions to 'searching' then 'assigned'/'driver_accepted'.

## TD-066 (Phase 6.1): No external map, no live ETA yet
Response includes distance_km (straight-line). Real ETA comes from Phase 7 map layer (free tier or mock).
## TD-067 (Phase 6.2): Dispatch offers as first-class rows
dispatch_offers records every offer (round, radius, distance, response).
Unique partial indexes guarantee:
  - At most one live pending offer per booking (single sequential flow)
  - At most one live pending offer per driver (no double-queueing)
UNIQUE violation on race -> caller returns the new live offer.

## TD-068 (Phase 6.2): Radius rounds = [5, 10, 30] km by default
Configurable via DISPATCH_RADIUS_ROUNDS_KM (comma-separated).
Each round: pick top candidate by ascending haversine distance from pickup.
If round 1 has a candidate, offer them; on reject/timeout, try next in round 1 before escalating.
Once a round exhausts candidates, expand to next radius.
After final round -> no_driver_available.

## TD-069 (Phase 6.2): 20-second default offer timeout
Configurable via DISPATCH_OFFER_TIMEOUT_MS.
Timeout handling is 'lazy': advanceDispatch() expires stale offers at the start of each call.
Phase 6.2 endpoint /dispatch/advance acts as manual sweeper (customer triggers).
Phase 7+ will add a background sweeper (Node setInterval or external cron).

## TD-070 (Phase 6.2): Atomic accept via single UPDATE
tryAccept uses:
  UPDATE bookings SET driver_id=?, recovery_vehicle_id=?, status='assigned', accepted_at=?, updated_at=?
  WHERE id=? AND status='searching'
If changes != 1 -> lost_race (409). SQLite single-writer semantics guarantee this even under concurrency.

## TD-071 (Phase 6.2): Eligibility re-checked at accept time
A driver who was eligible at offer time may not be at accept time (docs expired, GPS stale, went offline).
Such accepts return 403 with blockers and mark offer remains pending (until expired).
Dispatcher will advance.

## TD-072 (Phase 6.2): Reject triggers synchronous advance
POST /reject: marks offer rejected, immediately calls advanceDispatch() to offer next candidate.
No background timer needed for happy path.
Client can poll GET /incoming or GET /bookings/:id to observe next offer.

## TD-073 (Phase 6.2): Driver endpoint path /api/driver/bookings/*
Separate from /api/driver (self profile, docs, GPS).
Customer-triggered dispatch endpoints under /api/customer/bookings/:id/dispatch[/advance].

## TD-074 (Phase 6.2): Booking flow after accept
created -> searching -> assigned (atomic).
Trip operations (on_way, arrived, loaded, etc.) are Phase 7.
## TD-075 (Phase 7): Trip transitions via whitelist state machine
ALLOWED_TRANSITIONS in src/booking/tripTransitions.js.
Any from->to not in the list -> 409 invalid_status_transition.
Timestamps (arrived_at, loaded_at, completed_at, cancelled_at) set automatically by tryTransition.

## TD-076 (Phase 7): Atomic transitions via single UPDATE ... WHERE status = 'from'
All transition endpoints are safe under concurrent calls.
The WHERE clause's status guard is the sole arbiter.

## TD-077 (Phase 7): GPS proximity for arrival
POST /arrived requires driver.last_gps within TRIP_ARRIVAL_GPS_THRESHOLD_M (default 200m).
On failure -> 409 gps_not_near_pickup with distance and hint.
Override: body { manual_fallback: true, reason: '...' } -> allowed if config.trip.allowManualArrivalFallback.
Manual fallbacks are logged in booking_status_history metadata.

## TD-078 (Phase 7): Cancellation policy
Customer:
  - created/searching -> 0 fee (no driver assigned)
  - assigned/driver_on_way/driver_arrived:
    - within free_cancel_seconds of created_at -> 0 fee
    - after -> cancellation_fee_minor from country_settings
  - vehicle_loaded/trip_in_progress -> NOT cancellable (409)
Driver:
  - allowed only from assigned / driver_on_way
  - requires reason (min 3 chars)
  - 0 fee to customer

## TD-079 (Phase 7): Customer tracking endpoint
GET /api/customer/bookings/:id/tracking returns:
  booking, customer_vehicle_snapshot, fare_breakdown, driver (phone only if
  country_settings.contact_privacy_mode = 'show_number'), recovery_vehicle,
  live { driver_gps, distance_to_pickup_km, distance_to_destination_km },
  timeline (from booking_status_history), cancellation_policy.
No live ETA yet (no routing engine).

## TD-080 (Phase 7): Driver active booking endpoint
GET /api/driver/bookings/active returns current non-terminal booking or null.
Active statuses: assigned, driver_on_way, driver_arrived, vehicle_loaded, trip_in_progress.
Enables driver UI to resume trip after app restart.

## TD-081 (Phase 7): Trip completion does not touch payments
trip_completed is the terminal trip state. Payment flow (payment_pending, payment_completed)
is Phase 8. completed_at is set, but no payment row is created yet.

## TD-082 (Phase 7): Manual arrival fallback audit
metadata in booking_status_history: { gps: { distance_m, threshold_m, within }, manual_fallback?, manual_reason? }
Also in audit_logs for admin review.
## TD-083 (Phase 8): Payment states
Bookings: trip_completed -> payment_pending -> payment_completed | disputed.
Cash flow: driver cash-received (transition to payment_pending, create 'cash' pending payment row),
then customer cash-paid (update row to paid, transition to payment_completed).
Online test: initiate (create 'test' authorized), confirm (update to paid, transition).
Master plan Â§17.1: cash received by driver + customer confirmation are separate actions.

## TD-084 (Phase 8): Customer confirmation is required for cash
Driver cash-received alone leaves booking in payment_pending (payment row status='pending').
Only customer cash-paid transitions to payment_completed (row status='paid').
Master plan Â§17.1: "Customer-à´¨àµà´±àµ† à´¸àµà´¥à´¿à´°àµ€à´•à´°à´£à´®à´¿à´²àµà´²à´¾à´¤àµ† cash payment completed à´†à´¯à´¿ à´¸àµà´µà´®àµ‡à´§à´¯à´¾ à´…à´Ÿà´¯à´¾à´³à´ªàµà´ªàµ†à´Ÿàµà´¤àµà´¤à´°àµà´¤àµ".

## TD-085 (Phase 8): Test online blocked in production
Endpoint POST /:id/payment/online/test returns 403 if config.nodeEnv === 'production'.
Master plan Â§17.2: "Fake payment success production-àµ½ à´…à´¨àµà´µà´¦à´¿à´•àµà´•à´°àµà´¤àµ".
Response field is_test: true always. provider='test', provider_ref='TEST-<random>'.

## TD-086 (Phase 8): Amounts are server-controlled
payments.amount_minor = booking.agreed_fare_minor at creation.
Client may pass body.amount_minor; must match exactly -> 409 amount_mismatch.
Prevents tampering.

## TD-087 (Phase 8): Idempotency per (scope, key)
Scopes: 'payment.cash_paid:<bookingId>', 'payment.online_test:<bookingId>'.
Reuse idempotency_keys table. Same key+body -> stored response. Different -> 409.
Unique index ux_payments_booking_method allows only one 'cash' and one 'test' row per booking.

## TD-088 (Phase 8): Dispute flow
Either customer or driver can open dispute from trip_completed, payment_pending, or payment_completed.
Requires reason (min 3 chars). Transitions booking -> disputed.
Also marks all existing payment rows to 'disputed' and adds payment_events entries.
No admin resolution endpoint yet â€” Phase 9 (Support/Disputes UI).

## TD-089 (Phase 8): payment_events is append-only
Every state change writes an event: cash_paid, cash_received_by_driver, cash_received_by_driver_late,
online_test_authorized, online_test_confirmed, dispute_opened.
Queryable via GET /api/customer/bookings/:id/payment.

## TD-090 (Phase 8): Real payment gateway deferred
No live gateway integration in this phase. provider='test' only.
Future: swap in Stripe/Tap/PayTabs via provider adapter. payments.provider_ref stores gateway reference.
## TD-091 (Phase 9): Support tickets per country + creator scoping
support_tickets.country_id from creator's country. created_by_role in (customer|driver|agency).
Customers/drivers list/read only their own tickets. Country admins see all tickets in their country.
Super admin sees all.
Statuses: open -> under_review -> waiting_customer -> resolved -> closed.

## TD-092 (Phase 9): In-app chat per booking
chat_messages scoped to booking_id. sender_role customer|driver only.
Read/write requires the caller to be the booking's customer or assigned driver.
Message send triggers notify() to the other party.

## TD-093 (Phase 9): Notifications table with data_json
Per-user feed. read_at null = unread. Ordering by id desc.
GET /api/{customer,driver}/notifications?unread=1 filters.
POST /api/{customer,driver}/notifications/read-all marks all as read.

## TD-094 (Phase 9): Notification kinds emitted
- booking.assigned -> customer (on accept)
- booking.trip_completed -> customer (on complete)
- payment.cash_paid -> driver (customer confirmed cash)
- payment.cash_received -> customer (driver recorded cash)
- payment.online_paid -> driver (online confirmed)
- dispute.opened -> driver + all country admins
- dispute.resolved -> customer + driver
- chat.message -> recipient (customer<->driver)
- ticket.created -> all country admins of the ticket's country
- ticket.assigned -> assigned admin + creator
- ticket.message -> creator
- ticket.updated -> creator
- ticket.resolved -> creator

## TD-095 (Phase 9): Admin dispute resolution
POST /api/admin/bookings/:id/payment/resolve-dispute
target_status in (payment_pending | payment_completed | cancelled).
Requires booking.status === 'disputed'. Country admin scoped to own country.
State machine updated: 'disputed' -> ['payment_pending','payment_completed','cancelled'].
Payment rows in 'disputed' transition to: paid (if payment_completed),
failed (if cancelled), pending (if payment_pending). All transitions logged as payment_events.

## TD-096 (Phase 9): Notifications emitted inside same transaction
All notify() calls are inside withTransaction blocks with their originating event.
Prevents notification drift (write lost if booking update rolls back).

## TD-097 (Phase 9): Message lengths enforced
subject <= 120, description <= 4000, ticket message <= 2000, chat <= 1000.
Configurable via config.support.*.

## TD-098 (Phase 9): Push notifications deferred
In-app only. No push provider integration.
Later phase: web-push, FCM, or APNs via provider adapter with user.notification tokens table.
## TD-099 (Phase 9 - Known Gap): Accept/complete notification hooks
The `driverBookings.js` accept and complete endpoints MAY not fire
`notifyBookingCustomer` reliably. Root cause TBD — likely the try/catch
swallows errors, or the hook is placed after an early return.
Impact: customers may not receive `booking.assigned` / `booking.trip_completed`
in-app notifications from those transitions.
Mitigation: The `notifications` API itself (list, unread filter, mark-read,
mark-all) is verified working via chat messages and other notification sources.
Fix scheduled: Phase 10 (before dashboards), as part of report integration testing.
Test: `support9.test.js` uses chat fallback to verify API behavior regardless.
