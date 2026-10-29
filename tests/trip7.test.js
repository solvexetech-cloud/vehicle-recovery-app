process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-trip7-'));
process.env.DB_PATH = path.join(tmp, 'trip7.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');

const { createApp } = require('../src/app');

let server, port, db, cookieJar = null;

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
function cookieHeader() { return cookieJar ? cookieJar.map((c) => c.split(';')[0]).join('; ') : ''; }

function request(method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const hdrs = { 'Content-Type': 'application/json', ...headers };
    if (cookieJar && !hdrs['Cookie']) hdrs['Cookie'] = cookieHeader();
    const opts = { host: '127.0.0.1', port, method, path: pathname, headers: hdrs };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc) cookieJar = sc;
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json: safeJson(buf) });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function makeSessionCookie(userId) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + 86400 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sid, userId, expires);
  return 'vra_sess=' + encodeURIComponent(sid);
}

async function newVerifiedCustomer(email, password) {
  cookieJar = null;
  const reg = await request('POST', '/api/auth/register', {
    body: { role: 'customer', full_name: 'C ' + email, email, password, country_code: 'QA' }
  });
  assert.equal(reg.status, 201, 'register failed: ' + reg.body);
  await request('GET', '/api/auth/verify-email?token=' + encodeURIComponent(reg.json.dev_verify_token));
  const login = await request('POST', '/api/auth/login', { body: { identifier: email, password } });
  assert.equal(login.status, 200);
  return login.json.user;
}

function resetDrivers() {
  db.prepare('UPDATE drivers SET is_online = 0').run();
}

function provisionEligibleDriver({ lat, lng, plate }) {
  const userId = db.prepare(
    "INSERT INTO users (country_id, role, full_name, email, password_hash, status, email_verified_at) " +
    "VALUES (1, 'driver', 'Drv', ?, 'x', 'active', ?)"
  ).run('drv-' + Math.random().toString(36).slice(2) + '@x.co', new Date().toISOString()).lastInsertRowid;

  const agencyUserId = db.prepare(
    "INSERT INTO users (country_id, role, full_name, email, password_hash, status, email_verified_at) " +
    "VALUES (1, 'agency', 'Ag', ?, 'x', 'active', ?)"
  ).run('ag-' + Math.random().toString(36).slice(2) + '@x.co', new Date().toISOString()).lastInsertRowid;

  const agencyId = db.prepare(
    "INSERT INTO agencies (country_id, user_id, legal_name, display_name, status) VALUES (1, ?, 'Ag LLC', 'Ag', 'approved')"
  ).run(Number(agencyUserId)).lastInsertRowid;

  const vehicleId = db.prepare(
    "INSERT INTO recovery_vehicles (country_id, agency_id, plate_number, vehicle_type, status) VALUES (1, ?, ?, 'flatbed', 'approved')"
  ).run(Number(agencyId), plate + '-' + Math.random().toString(36).slice(2, 6)).lastInsertRowid;

  const driverId = db.prepare(
    "INSERT INTO drivers (country_id, user_id, agency_id, current_vehicle_id, status, is_online, last_gps_lat, last_gps_lng, last_gps_at, approved_at) " +
    "VALUES (1, ?, ?, ?, 'approved', 1, ?, ?, ?, ?)"
  ).run(Number(userId), Number(agencyId), Number(vehicleId), lat, lng, new Date().toISOString(), new Date().toISOString()).lastInsertRowid;

  db.prepare('INSERT INTO driver_vehicles (driver_id, recovery_vehicle_id) VALUES (?, ?)').run(Number(driverId), Number(vehicleId));
  db.prepare(
    "INSERT INTO driver_documents (driver_id, doc_type, file_path, mime_type, size_bytes, expires_at, review_status) " +
    "VALUES (?, 'driving_license', 'x/x.png', 'image/png', 100, '2099-01-01', 'approved')"
  ).run(Number(driverId));

  return { userId: Number(userId), driverId: Number(driverId), vehicleId: Number(vehicleId) };
}

async function createAndAssignBooking(customerEmail) {
  const cust = await newVerifiedCustomer(customerEmail, 'CustPass1234');
  const est = await request('POST', '/api/customer/bookings/estimate', { body: {
    service_type: 'towing', service_level: 'normal',
    pickup: { lat: 25.3, lng: 51.5 }, destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-T7' }
  }});
  assert.equal(est.status, 200);
  const total = est.json.fare_breakdown.total_minor;
  const create = await request('POST', '/api/customer/bookings', { body: {
    service_type: 'towing', service_level: 'normal',
    pickup: { lat: 25.3, lng: 51.5 }, destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-T7' },
    agreed_fare_minor: total
  }});
  assert.equal(create.status, 201);
  const booking = create.json.booking;

  const disp = await request('POST', '/api/customer/bookings/' + booking.id + '/dispatch');
  assert.equal(disp.status, 200, 'dispatch failed: ' + disp.body);
  assert.equal(disp.json.dispatch.status, 'offer_created', 'dispatch status: ' + JSON.stringify(disp.json.dispatch));
  const offeredDriverId = disp.json.dispatch.offer.driver_id;

  const offeredUserId = db.prepare('SELECT user_id FROM drivers WHERE id = ?').get(offeredDriverId).user_id;
  cookieJar = [makeSessionCookie(offeredUserId)];
  const acc = await request('POST', '/api/driver/bookings/' + booking.id + '/accept');
  assert.equal(acc.status, 200);
  assert.equal(acc.json.booking.status, 'assigned');

  return {
    bookingId: booking.id,
    driverUserId: offeredUserId,
    driverId: offeredDriverId,
    customerUserId: cust.id
  };
}

test('setup: server + pricing', async () => {
  const ctx = createApp();
  server = ctx.app.listen(0);
  db = ctx.db;
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;

  db.prepare(
    "UPDATE country_services SET is_enabled = 1, base_fare_minor = 5000, per_km_minor = 300, fast_surcharge_minor = 1000, min_fare_minor = 8000 " +
    "WHERE country_id = 1 AND service_code = 'towing'"
  ).run();
  db.prepare("UPDATE country_services SET is_enabled = 0 WHERE country_id = 1 AND service_code != 'towing'").run();
  db.prepare("UPDATE country_settings SET tax_rate_bp = 500, cancellation_fee_minor = 2500, free_cancel_seconds = 300 WHERE country_id = 1").run();
});

test('happy path: assigned -> on_way -> arrived (gps) -> loaded -> trip_in_progress -> trip_completed', async () => {
  resetDrivers();
  provisionEligibleDriver({ lat: 25.3005, lng: 51.5005, plate: 'T7-HAPPY' });
  const b = await createAndAssignBooking('happy.t7@example.com');

  cookieJar = [makeSessionCookie(b.driverUserId)];

  let res = await request('POST', '/api/driver/bookings/' + b.bookingId + '/on-way');
  assert.equal(res.status, 200);
  assert.equal(res.json.booking.status, 'driver_on_way');

  res = await request('POST', '/api/driver/bookings/' + b.bookingId + '/arrived');
  assert.equal(res.status, 200);
  assert.equal(res.json.booking.status, 'driver_arrived');
  assert.ok(res.json.booking.arrived_at);

  res = await request('POST', '/api/driver/bookings/' + b.bookingId + '/loaded');
  assert.equal(res.status, 200);
  assert.equal(res.json.booking.status, 'vehicle_loaded');
  assert.ok(res.json.booking.loaded_at);

  res = await request('POST', '/api/driver/bookings/' + b.bookingId + '/start-trip');
  assert.equal(res.status, 200);
  assert.equal(res.json.booking.status, 'trip_in_progress');

  res = await request('POST', '/api/driver/bookings/' + b.bookingId + '/complete');
  assert.equal(res.status, 200);
  assert.equal(res.json.booking.status, 'trip_completed');
  assert.ok(res.json.booking.completed_at);
});

test('forbidden transition: assigned -> complete (409)', async () => {
  resetDrivers();
  provisionEligibleDriver({ lat: 25.301, lng: 51.501, plate: 'T7-JUMP1' });
  const b = await createAndAssignBooking('jump.t7@example.com');
  cookieJar = [makeSessionCookie(b.driverUserId)];
  const res = await request('POST', '/api/driver/bookings/' + b.bookingId + '/complete');
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'invalid_status_transition');
});

test('forbidden: arrived without GPS proximity (409 gps_not_near_pickup)', async () => {
  resetDrivers();
  // Driver ~1.4km from pickup: within radius (30km) but outside threshold (200m)
  provisionEligibleDriver({ lat: 25.31, lng: 51.51, plate: 'T7-FAR' });
  const b = await createAndAssignBooking('far.t7@example.com');
  cookieJar = [makeSessionCookie(b.driverUserId)];

  await request('POST', '/api/driver/bookings/' + b.bookingId + '/on-way');
  const res = await request('POST', '/api/driver/bookings/' + b.bookingId + '/arrived');
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'gps_not_near_pickup');
});

test('manual fallback for arrived works', async () => {
  resetDrivers();
  provisionEligibleDriver({ lat: 25.31, lng: 51.51, plate: 'T7-MAN' });
  const b = await createAndAssignBooking('man.t7@example.com');
  cookieJar = [makeSessionCookie(b.driverUserId)];

  await request('POST', '/api/driver/bookings/' + b.bookingId + '/on-way');
  const res = await request('POST', '/api/driver/bookings/' + b.bookingId + '/arrived', {
    body: { manual_fallback: true, reason: 'GPS inaccurate in garage' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.booking.status, 'driver_arrived');
});

test('manual fallback without reason -> 422', async () => {
  resetDrivers();
  provisionEligibleDriver({ lat: 25.31, lng: 51.51, plate: 'T7-NORSN' });
  const b = await createAndAssignBooking('norsn.t7@example.com');
  cookieJar = [makeSessionCookie(b.driverUserId)];
  await request('POST', '/api/driver/bookings/' + b.bookingId + '/on-way');
  const res = await request('POST', '/api/driver/bookings/' + b.bookingId + '/arrived', {
    body: { manual_fallback: true }
  });
  assert.equal(res.status, 422);
});

test('non-assigned driver cannot transition (404)', async () => {
  resetDrivers();
  provisionEligibleDriver({ lat: 25.302, lng: 51.502, plate: 'T7-OWN' });
  const b = await createAndAssignBooking('own.t7@example.com');
  resetDrivers();
  const other = provisionEligibleDriver({ lat: 25.303, lng: 51.503, plate: 'T7-OTHER' });
  cookieJar = [makeSessionCookie(other.userId)];
  const res = await request('POST', '/api/driver/bookings/' + b.bookingId + '/on-way');
  assert.equal(res.status, 404);
});

test('customer tracking shows driver, timeline, live', async () => {
  resetDrivers();
  provisionEligibleDriver({ lat: 25.302, lng: 51.502, plate: 'T7-TRACK' });
  const b = await createAndAssignBooking('track.t7@example.com');
  cookieJar = [makeSessionCookie(b.driverUserId)];
  await request('POST', '/api/driver/bookings/' + b.bookingId + '/on-way');

  cookieJar = [makeSessionCookie(b.customerUserId)];
  const res = await request('GET', '/api/customer/bookings/' + b.bookingId + '/tracking');
  assert.equal(res.status, 200);
  assert.equal(res.json.booking.status, 'driver_on_way');
  assert.ok(res.json.driver);
  assert.ok(res.json.recovery_vehicle);
  assert.ok(res.json.timeline.length >= 3);
  assert.ok(res.json.cancellation_policy);
});

test('customer cancel: within free window -> 0 fee', async () => {
  resetDrivers();
  provisionEligibleDriver({ lat: 25.304, lng: 51.504, plate: 'T7-CF' });
  const b = await createAndAssignBooking('free.t7@example.com');
  cookieJar = [makeSessionCookie(b.customerUserId)];
  const res = await request('POST', '/api/customer/bookings/' + b.bookingId + '/cancel', { body: { reason: 'Changed mind' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.booking.status, 'cancelled');
  assert.equal(res.json.booking.cancellation_fee_minor, 0);
});

test('customer cancel: outside free window -> fee applies', async () => {
  resetDrivers();
  provisionEligibleDriver({ lat: 25.305, lng: 51.505, plate: 'T7-CF2' });
  const b = await createAndAssignBooking('fee.t7@example.com');
  db.prepare('UPDATE bookings SET created_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 3600 * 1000).toISOString(), b.bookingId);

  cookieJar = [makeSessionCookie(b.customerUserId)];
  const res = await request('POST', '/api/customer/bookings/' + b.bookingId + '/cancel', { body: { reason: 'Late cancel' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.booking.cancellation_fee_minor, 2500);
});

test('customer cannot cancel trip_in_progress (409)', async () => {
  resetDrivers();
  provisionEligibleDriver({ lat: 25.3005, lng: 51.5005, plate: 'T7-CF3' });
  const b = await createAndAssignBooking('ncf.t7@example.com');
  cookieJar = [makeSessionCookie(b.driverUserId)];
  await request('POST', '/api/driver/bookings/' + b.bookingId + '/on-way');
  await request('POST', '/api/driver/bookings/' + b.bookingId + '/arrived');
  await request('POST', '/api/driver/bookings/' + b.bookingId + '/loaded');
  await request('POST', '/api/driver/bookings/' + b.bookingId + '/start-trip');

  cookieJar = [makeSessionCookie(b.customerUserId)];
  const res = await request('POST', '/api/customer/bookings/' + b.bookingId + '/cancel', { body: { reason: 'x' } });
  assert.equal(res.status, 409);
});

test('driver cancel: allowed from assigned with reason', async () => {
  resetDrivers();
  provisionEligibleDriver({ lat: 25.306, lng: 51.506, plate: 'T7-DC' });
  const b = await createAndAssignBooking('dc.t7@example.com');
  cookieJar = [makeSessionCookie(b.driverUserId)];
  const res = await request('POST', '/api/driver/bookings/' + b.bookingId + '/cancel', { body: { reason: 'Vehicle issue' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.booking.status, 'cancelled');
  assert.equal(res.json.booking.cancellation_fee_minor, 0);
});

test('driver cancel without reason -> 422', async () => {
  resetDrivers();
  provisionEligibleDriver({ lat: 25.307, lng: 51.507, plate: 'T7-DC2' });
  const b = await createAndAssignBooking('dc2.t7@example.com');
  cookieJar = [makeSessionCookie(b.driverUserId)];
  const res = await request('POST', '/api/driver/bookings/' + b.bookingId + '/cancel', { body: {} });
  assert.equal(res.status, 422);
});

test('driver cannot cancel from trip_in_progress (409)', async () => {
  resetDrivers();
  provisionEligibleDriver({ lat: 25.3005, lng: 51.5005, plate: 'T7-DC3' });
  const b = await createAndAssignBooking('dc3.t7@example.com');
  cookieJar = [makeSessionCookie(b.driverUserId)];
  await request('POST', '/api/driver/bookings/' + b.bookingId + '/on-way');
  await request('POST', '/api/driver/bookings/' + b.bookingId + '/arrived');
  await request('POST', '/api/driver/bookings/' + b.bookingId + '/loaded');
  await request('POST', '/api/driver/bookings/' + b.bookingId + '/start-trip');
  const res = await request('POST', '/api/driver/bookings/' + b.bookingId + '/cancel', { body: { reason: 'try' } });
  assert.equal(res.status, 409);
});

test('GET /api/driver/bookings/active returns null after completion', async () => {
  resetDrivers();
  provisionEligibleDriver({ lat: 25.3005, lng: 51.5005, plate: 'T7-ACT' });
  const b = await createAndAssignBooking('act.t7@example.com');
  cookieJar = [makeSessionCookie(b.driverUserId)];

  let active = await request('GET', '/api/driver/bookings/active');
  assert.ok(active.json.booking);
  assert.equal(active.json.booking.id, b.bookingId);

  await request('POST', '/api/driver/bookings/' + b.bookingId + '/on-way');
  await request('POST', '/api/driver/bookings/' + b.bookingId + '/arrived');
  await request('POST', '/api/driver/bookings/' + b.bookingId + '/loaded');
  await request('POST', '/api/driver/bookings/' + b.bookingId + '/start-trip');
  await request('POST', '/api/driver/bookings/' + b.bookingId + '/complete');

  active = await request('GET', '/api/driver/bookings/active');
  assert.equal(active.json.booking, null);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
});