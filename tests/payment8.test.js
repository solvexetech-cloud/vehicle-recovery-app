process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-p8-'));
process.env.DB_PATH = path.join(tmp, 'p8.db');
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

// CRITICAL: reset all drivers offline AND cancel any lingering bookings so each test starts clean
function resetAllDrivers() {
  db.prepare('UPDATE drivers SET is_online = 0').run();
  // Cancel any in-flight bookings so driver "one active at a time" rule doesn't block
  db.prepare("UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE status NOT IN ('trip_completed','payment_completed','cancelled','no_driver_available','disputed','payment_failed')")
    .run(new Date().toISOString());
  // Expire any pending dispatch offers
  db.prepare("UPDATE dispatch_offers SET response = 'expired', responded_at = ? WHERE response = 'pending'")
    .run(new Date().toISOString());
}

function provisionEligibleDriver({ plate }) {
  resetAllDrivers(); // This test's driver is the ONLY online one
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
    "VALUES (1, ?, ?, ?, 'approved', 1, 25.3005, 51.5005, ?, ?)"
  ).run(Number(userId), Number(agencyId), Number(vehicleId), new Date().toISOString(), new Date().toISOString()).lastInsertRowid;

  db.prepare('INSERT INTO driver_vehicles (driver_id, recovery_vehicle_id) VALUES (?, ?)').run(Number(driverId), Number(vehicleId));
  db.prepare(
    "INSERT INTO driver_documents (driver_id, doc_type, file_path, mime_type, size_bytes, expires_at, review_status) " +
    "VALUES (?, 'driving_license', 'x/x.png', 'image/png', 100, '2099-01-01', 'approved')"
  ).run(Number(driverId));

  return { userId: Number(userId), driverId: Number(driverId), vehicleId: Number(vehicleId) };
}

async function completeTripForCustomer(customerEmail) {
  // NOTE: resetAllDrivers already happens inside provisionEligibleDriver
  const cust = await newVerifiedCustomer(customerEmail, 'CustPass1234');
  const est = await request('POST', '/api/customer/bookings/estimate', { body: {
    service_type: 'towing', service_level: 'normal',
    pickup: { lat: 25.3, lng: 51.5 }, destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-P8' }
  }});
  assert.equal(est.status, 200);
  const total = est.json.fare_breakdown.total_minor;
  const create = await request('POST', '/api/customer/bookings', { body: {
    service_type: 'towing', service_level: 'normal',
    pickup: { lat: 25.3, lng: 51.5 }, destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-P8' }, agreed_fare_minor: total
  }});
  assert.equal(create.status, 201, 'booking create failed: ' + create.body);
  const booking = create.json.booking;

  const disp = await request('POST', '/api/customer/bookings/' + booking.id + '/dispatch');
  assert.equal(disp.status, 200, 'dispatch failed: ' + disp.body);
  assert.equal(disp.json.dispatch.status, 'offer_created', 'dispatch not offered: ' + JSON.stringify(disp.json.dispatch));
  const offeredUserId = db.prepare('SELECT user_id FROM drivers WHERE id = ?').get(disp.json.dispatch.offer.driver_id).user_id;

  cookieJar = [makeSessionCookie(offeredUserId)];
  const acc = await request('POST', '/api/driver/bookings/' + booking.id + '/accept');
  assert.equal(acc.status, 200, 'accept failed: ' + acc.body);
  await request('POST', '/api/driver/bookings/' + booking.id + '/on-way');
  await request('POST', '/api/driver/bookings/' + booking.id + '/arrived', { body: { manual_fallback: true, reason: 'test' } });
  await request('POST', '/api/driver/bookings/' + booking.id + '/loaded');
  await request('POST', '/api/driver/bookings/' + booking.id + '/start-trip');
  const comp = await request('POST', '/api/driver/bookings/' + booking.id + '/complete');
  assert.equal(comp.status, 200, 'complete failed: ' + comp.body);

  return { booking, driverUserId: offeredUserId, customerUserId: cust.id, agreedFare: total };
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
  db.prepare("UPDATE country_settings SET tax_rate_bp = 500 WHERE country_id = 1").run();
});

test('anonymous cannot access payment endpoints (401)', async () => {
  cookieJar = null;
  const a = await request('GET', '/api/customer/bookings/1/payment');
  assert.equal(a.status, 401);
  const b = await request('POST', '/api/customer/bookings/1/payment/cash-paid', { body: {} });
  assert.equal(b.status, 401);
});

test('cash-paid happy path: trip_completed -> payment_completed', async () => {
  provisionEligibleDriver({ plate: 'P8-CASH' });
  const x = await completeTripForCustomer('cash.p8@example.com');

  cookieJar = [makeSessionCookie(x.customerUserId)];
  const res = await request('POST', '/api/customer/bookings/' + x.booking.id + '/payment/cash-paid', {
    body: { amount_minor: x.agreedFare }
  });
  assert.equal(res.status, 201, 'cash-paid failed: ' + res.body);
  assert.equal(res.json.booking.status, 'payment_completed');
  assert.equal(res.json.payment.method, 'cash');
  assert.equal(res.json.payment.status, 'paid');
});

test('cash-paid wrong amount -> 409 amount_mismatch', async () => {
  provisionEligibleDriver({ plate: 'P8-MIS' });
  const x = await completeTripForCustomer('mis.p8@example.com');
  cookieJar = [makeSessionCookie(x.customerUserId)];
  const res = await request('POST', '/api/customer/bookings/' + x.booking.id + '/payment/cash-paid', {
    body: { amount_minor: x.agreedFare + 100 }
  });
  assert.equal(res.status, 409, 'expected 409, got ' + res.body);
  assert.equal(res.json.error, 'conflict');
  assert.equal(res.json.message, 'amount_mismatch');
});

test('cash-paid on assigned (not payable) -> 409', async () => {
  provisionEligibleDriver({ plate: 'P8-BAD' });
  const x = await completeTripForCustomer('bad.p8@example.com');
  db.prepare("UPDATE bookings SET status = 'assigned' WHERE id = ?").run(x.booking.id);
  cookieJar = [makeSessionCookie(x.customerUserId)];
  const res = await request('POST', '/api/customer/bookings/' + x.booking.id + '/payment/cash-paid', { body: {} });
  assert.equal(res.status, 409);
});

test('driver cash-received from trip_completed -> payment_pending', async () => {
  provisionEligibleDriver({ plate: 'P8-DRV' });
  const x = await completeTripForCustomer('drv.p8@example.com');
  cookieJar = [makeSessionCookie(x.driverUserId)];
  const res = await request('POST', '/api/driver/bookings/' + x.booking.id + '/payment/cash-received', {
    body: { amount_minor: x.agreedFare }
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.booking.status, 'payment_pending');
  assert.equal(res.json.payment.method, 'cash');
  assert.equal(res.json.payment.status, 'pending');

  cookieJar = [makeSessionCookie(x.customerUserId)];
  const pay = await request('POST', '/api/customer/bookings/' + x.booking.id + '/payment/cash-paid', {});
  assert.equal(pay.status, 201);
  assert.equal(pay.json.booking.status, 'payment_completed');
});

test('online test initiate + confirm -> payment_completed', async () => {
  provisionEligibleDriver({ plate: 'P8-ONL' });
  const x = await completeTripForCustomer('onl.p8@example.com');
  cookieJar = [makeSessionCookie(x.customerUserId)];

  const init = await request('POST', '/api/customer/bookings/' + x.booking.id + '/payment/online/test', {});
  assert.equal(init.status, 201, 'online test init failed: ' + init.body);
  assert.equal(init.json.is_test, true);
  assert.equal(init.json.payment.status, 'authorized');
  assert.match(init.json.payment.provider_ref, /^TEST-/);

  const conf = await request('POST', '/api/customer/bookings/' + x.booking.id + '/payment/online/test/confirm', {});
  assert.equal(conf.status, 200);
  assert.equal(conf.json.booking.status, 'payment_completed');
  assert.equal(conf.json.payment.status, 'paid');
});

test('online test initiate in production -> 403', async () => {
  provisionEligibleDriver({ plate: 'P8-PROD' });
  const x = await completeTripForCustomer('prod.p8@example.com');
  cookieJar = [makeSessionCookie(x.customerUserId)];

  const config = require('../src/config');
  const orig = config.nodeEnv;
  config.nodeEnv = 'production';
  try {
    const res = await request('POST', '/api/customer/bookings/' + x.booking.id + '/payment/online/test', {});
    assert.equal(res.status, 403);
  } finally {
    config.nodeEnv = orig;
  }
});

test('idempotency: same key + same body returns same cash payment', async () => {
  provisionEligibleDriver({ plate: 'P8-IDEM' });
  const x = await completeTripForCustomer('idem.p8@example.com');
  cookieJar = [makeSessionCookie(x.customerUserId)];

  const headers = { 'Idempotency-Key': 'p8-idem-' + Date.now() };
  const a = await request('POST', '/api/customer/bookings/' + x.booking.id + '/payment/cash-paid', {
    body: { amount_minor: x.agreedFare }, headers
  });
  const b = await request('POST', '/api/customer/bookings/' + x.booking.id + '/payment/cash-paid', {
    body: { amount_minor: x.agreedFare }, headers
  });
  assert.equal(a.status, 201, 'first cash-paid failed: ' + a.body);
  assert.equal(b.status, 200);
  assert.equal(a.json.payment.id, b.json.payment.id);
});

test('customer dispute -> booking disputed', async () => {
  provisionEligibleDriver({ plate: 'P8-DSP1' });
  const x = await completeTripForCustomer('dsp1.p8@example.com');
  cookieJar = [makeSessionCookie(x.customerUserId)];

  const res = await request('POST', '/api/customer/bookings/' + x.booking.id + '/payment/dispute', {
    body: { reason: 'Cash amount disagreed' }
  });
  assert.equal(res.status, 200, 'dispute failed: ' + res.body);
  assert.equal(res.json.booking.status, 'disputed');
});

test('driver dispute -> booking disputed', async () => {
  provisionEligibleDriver({ plate: 'P8-DSP2' });
  const x = await completeTripForCustomer('dsp2.p8@example.com');
  cookieJar = [makeSessionCookie(x.driverUserId)];

  const res = await request('POST', '/api/driver/bookings/' + x.booking.id + '/payment/dispute', {
    body: { reason: 'Customer did not pay' }
  });
  assert.equal(res.status, 200, 'dispute failed: ' + res.body);
  assert.equal(res.json.booking.status, 'disputed');
});

test('dispute without reason -> 422', async () => {
  provisionEligibleDriver({ plate: 'P8-DSP3' });
  const x = await completeTripForCustomer('dsp3.p8@example.com');
  cookieJar = [makeSessionCookie(x.customerUserId)];
  const res = await request('POST', '/api/customer/bookings/' + x.booking.id + '/payment/dispute', { body: {} });
  assert.equal(res.status, 422);
});

test('GET payment shows completed status after paid', async () => {
  provisionEligibleDriver({ plate: 'P8-GET' });
  const x = await completeTripForCustomer('get.p8@example.com');
  cookieJar = [makeSessionCookie(x.customerUserId)];

  await request('POST', '/api/customer/bookings/' + x.booking.id + '/payment/cash-paid', {});
  const res = await request('GET', '/api/customer/bookings/' + x.booking.id + '/payment');
  assert.equal(res.status, 200);
  assert.equal(res.json.booking_status, 'payment_completed');
  assert.equal(res.json.payment_status, 'paid');
  assert.ok(res.json.payments.length >= 1);
  assert.ok(res.json.events.length >= 1);
});

test('driver cannot use cash-paid (403 role guard)', async () => {
  provisionEligibleDriver({ plate: 'P8-DRV2' });
  const x = await completeTripForCustomer('drv2.p8@example.com');
  cookieJar = [makeSessionCookie(x.driverUserId)];
  const res = await request('POST', '/api/customer/bookings/' + x.booking.id + '/payment/cash-paid', { body: {} });
  assert.equal(res.status, 403);
});

test('double cash-paid after paid -> 409 already_paid', async () => {
  provisionEligibleDriver({ plate: 'P8-DBL' });
  const x = await completeTripForCustomer('dbl.p8@example.com');
  cookieJar = [makeSessionCookie(x.customerUserId)];
  const a = await request('POST', '/api/customer/bookings/' + x.booking.id + '/payment/cash-paid', {});
  assert.equal(a.status, 201, 'first cash-paid: ' + a.body);
  const b = await request('POST', '/api/customer/bookings/' + x.booking.id + '/payment/cash-paid', {});
  assert.equal(b.status, 409);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
});
