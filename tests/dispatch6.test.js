process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';
process.env.DISPATCH_OFFER_TIMEOUT_MS = '20000';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-dispatch6-'));
process.env.DB_PATH = path.join(tmp, 'dispatch6.db');
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

async function newVerifiedCustomer(email, password) {
  cookieJar = null;
  const reg = await request('POST', '/api/auth/register', {
    body: { role: 'customer', full_name: 'C ' + email, email, password, country_code: 'QA' }
  });
  assert.equal(reg.status, 201, 'register failed: ' + reg.body);
  const ver = await request('GET', '/api/auth/verify-email?token=' + encodeURIComponent(reg.json.dev_verify_token));
  assert.equal(ver.status, 200);
  const login = await request('POST', '/api/auth/login', { body: { identifier: email, password } });
  assert.equal(login.status, 200);
  return login.json.user;
}

// Provision a driver fully set up to be eligible: approved, authorized vehicle, approved doc, GPS, online
function provisionEligibleDriver({ lat, lng, plate = 'PL-D', taxRate = 500 }) {
  const email = 'drv-' + Math.random().toString(36).slice(2) + '@x.co';
  const userId = db.prepare(
    "INSERT INTO users (country_id, role, full_name, email, password_hash, status, email_verified_at) " +
    "VALUES (1, 'driver', 'Drv', ?, 'x', 'active', ?)"
  ).run(email, new Date().toISOString()).lastInsertRowid;

  // Agency (approved)
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

  db.prepare(
    "INSERT INTO driver_vehicles (driver_id, recovery_vehicle_id) VALUES (?, ?)"
  ).run(Number(driverId), Number(vehicleId));

  db.prepare(
    "INSERT INTO driver_documents (driver_id, doc_type, file_path, mime_type, size_bytes, expires_at, review_status) " +
    "VALUES (?, 'driving_license', 'x/x.png', 'image/png', 100, '2099-01-01', 'approved')"
  ).run(Number(driverId));

  return { userId: Number(userId), driverId: Number(driverId), vehicleId: Number(vehicleId), agencyId: Number(agencyId), email };
}

async function createBooking(customerEmail = 'booker.dr6@example.com') {
  await newVerifiedCustomer(customerEmail, 'CustPass1234');
  const est = await request('POST', '/api/customer/bookings/estimate', { body: {
    service_type: 'towing',
    service_level: 'normal',
    pickup: { lat: 25.3, lng: 51.5 },
    destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-DR6' }
  }});
  assert.equal(est.status, 200);
  const total = est.json.fare_breakdown.total_minor;
  const create = await request('POST', '/api/customer/bookings', { body: {
    service_type: 'towing',
    service_level: 'normal',
    pickup: { lat: 25.3, lng: 51.5 },
    destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-DR6' },
    agreed_fare_minor: total
  }});
  assert.equal(create.status, 201);
  return create.json.booking;
}

function driverLoginCookie(driverUserId) {
  // Directly create a session for the driver user (bypass password since hash is 'x')
  const sid = require('node:crypto').randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sid, driverUserId, expires);
  return 'vra_sess=' + encodeURIComponent(sid);
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

test('empty dispatch -> no_driver_available', async () => {
  const b = await createBooking('empty.cust@example.com');
  const res = await request('POST', '/api/customer/bookings/' + b.id + '/dispatch');
  assert.equal(res.status, 200);
  assert.equal(res.json.dispatch.status, 'no_driver');
});

test('booking is now no_driver_available', async () => {
  const list = await request('GET', '/api/customer/bookings');
  const nd = list.json.bookings.find((x) => x.status === 'no_driver_available');
  assert.ok(nd);
});

test('one eligible driver -> offer created on dispatch', async () => {
  const drv = provisionEligibleDriver({ lat: 25.305, lng: 51.505, plate: 'ELIG1' });
  const b = await createBooking('dr1.cust@example.com');
  const res = await request('POST', '/api/customer/bookings/' + b.id + '/dispatch');
  assert.equal(res.status, 200);
  assert.equal(res.json.dispatch.status, 'offer_created');
  assert.equal(res.json.dispatch.offer.driver_id, drv.driverId);
  assert.ok(res.json.dispatch.offer.expires_at);
});

test('driver sees incoming offer for own booking', async () => {
  // Find the most recent pending offer
  const offer = db.prepare("SELECT * FROM dispatch_offers WHERE response = 'pending' ORDER BY id DESC LIMIT 1").get();
  assert.ok(offer);
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(offer.driver_id);

  cookieJar = [{ 'set-cookie': [driverLoginCookie(driver.user_id)] }];
  // Convert to raw cookie format used by helper:
  cookieJar = [driverLoginCookie(driver.user_id)];
  const res = await request('GET', '/api/driver/bookings/incoming');
  assert.equal(res.status, 200);
  assert.ok(res.json.offer);
  assert.equal(res.json.offer.booking_id, offer.booking_id);
});

test('driver accepts -> booking becomes assigned', async () => {
  const offer = db.prepare("SELECT * FROM dispatch_offers WHERE response = 'pending' ORDER BY id DESC LIMIT 1").get();
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(offer.driver_id);

  cookieJar = [driverLoginCookie(driver.user_id)];
  const res = await request('POST', '/api/driver/bookings/' + offer.booking_id + '/accept');
  assert.equal(res.status, 200);
  assert.equal(res.json.booking.status, 'assigned');
  assert.equal(res.json.booking.driver_id, driver.id);
});

test('booking cannot be dispatched again after assigned', async () => {
  const offer = db.prepare("SELECT * FROM dispatch_offers WHERE response = 'accepted' ORDER BY id DESC LIMIT 1").get();
  // login as the customer of that booking
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(offer.booking_id);
  const cust = db.prepare('SELECT * FROM users WHERE id = ?').get(booking.customer_id);

  const sid = require('node:crypto').randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sid, cust.id, expires);
  cookieJar = ['vra_sess=' + encodeURIComponent(sid)];

  const res = await request('POST', '/api/customer/bookings/' + booking.id + '/dispatch');
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'conflict');
});

test('two drivers: only the offered driver can accept; second driver gets 409', async () => {
  const drvA = provisionEligibleDriver({ lat: 25.302, lng: 51.502, plate: 'RACE-A' });
  const drvB = provisionEligibleDriver({ lat: 25.303, lng: 51.503, plate: 'RACE-B' });
  const b = await createBooking('race.cust@example.com');
  const disp = await request('POST', '/api/customer/bookings/' + b.id + '/dispatch');
  assert.equal(disp.json.dispatch.status, 'offer_created');
  const offeredDriverId = disp.json.dispatch.offer.driver_id;
  const otherDriver = offeredDriverId === drvA.driverId ? drvB : drvA;

  // other driver (no offer) tries to accept
  cookieJar = [driverLoginCookie(otherDriver.userId)];
  const res = await request('POST', '/api/driver/bookings/' + b.id + '/accept');
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'no_active_offer');
});

test('driver rejects -> next candidate gets offer', async () => {
  const drvA = provisionEligibleDriver({ lat: 25.304, lng: 51.504, plate: 'REJ-A' });
  const drvB = provisionEligibleDriver({ lat: 25.306, lng: 51.506, plate: 'REJ-B' });
  const b = await createBooking('reject.cust@example.com');
  const disp = await request('POST', '/api/customer/bookings/' + b.id + '/dispatch');
  assert.equal(disp.json.dispatch.status, 'offer_created');
  const firstDriverId = disp.json.dispatch.offer.driver_id;

  // Reject as the current offered driver
  const firstDriverUser = db.prepare('SELECT user_id FROM drivers WHERE id = ?').get(firstDriverId).user_id;
  cookieJar = [driverLoginCookie(firstDriverUser)];
  const reject = await request('POST', '/api/driver/bookings/' + b.id + '/reject');
  assert.equal(reject.status, 200);
  assert.ok(['offer_created', 'pending_offer'].includes(reject.json.advanced.status));
  assert.ok(reject.json.advanced.next_offer_id);
  assert.notEqual(reject.json.advanced.next_driver_id, firstDriverId);
});

test('expired offer -> sweeper expires and re-offers (or no_driver)', async () => {
  const drv = provisionEligibleDriver({ lat: 25.308, lng: 51.508, plate: 'EXP-1' });
  const b = await createBooking('expire.cust@example.com');
  const disp = await request('POST', '/api/customer/bookings/' + b.id + '/dispatch');
  assert.equal(disp.json.dispatch.status, 'offer_created');
  const offerId = disp.json.dispatch.offer.id;

  // Backdate this offer so it's expired
  db.prepare("UPDATE dispatch_offers SET expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 60000).toISOString(), offerId);

  const adv = await request('POST', '/api/customer/bookings/' + b.id + '/dispatch/advance');
  assert.equal(adv.status, 200);
  // Only one eligible driver existed and now they've been excluded — no_driver
  assert.ok(['no_driver', 'offer_created'].includes(adv.json.dispatch.status));

  const check = db.prepare('SELECT response FROM dispatch_offers WHERE id = ?').get(offerId);
  assert.equal(check.response, 'expired');
});

test('customer cannot dispatch someone else\'s booking (404)', async () => {
  const b = await createBooking('mine.cust@example.com');
  await newVerifiedCustomer('other.cust.dr6@example.com', 'CustPass1234');
  const res = await request('POST', '/api/customer/bookings/' + b.id + '/dispatch');
  assert.equal(res.status, 404);
});

test('driver cannot see another driver\'s incoming offer', async () => {
  const drvA = provisionEligibleDriver({ lat: 25.31, lng: 51.51, plate: 'SELF-A' });
  const drvB = provisionEligibleDriver({ lat: 25.311, lng: 51.511, plate: 'SELF-B' });
  const b = await createBooking('self.cust@example.com');
  const disp = await request('POST', '/api/customer/bookings/' + b.id + '/dispatch');
  assert.equal(disp.json.dispatch.status, 'offer_created');
  const offeredDriverId = disp.json.dispatch.offer.driver_id;

  // Pick any driver OTHER than the offered one
  let otherDriverId = null;
  if (offeredDriverId !== drvA.driverId) otherDriverId = drvA.driverId;
  else if (offeredDriverId !== drvB.driverId) otherDriverId = drvB.driverId;
  else {
    const row = db.prepare("SELECT id FROM drivers WHERE id != ? AND status = 'approved' LIMIT 1").get(offeredDriverId);
    assert.ok(row, 'need at least one other approved driver');
    otherDriverId = row.id;
  }

  const otherDriverUserId = db.prepare('SELECT user_id FROM drivers WHERE id = ?').get(otherDriverId).user_id;
  cookieJar = [driverLoginCookie(otherDriverUserId)];
  const res = await request('GET', '/api/driver/bookings/incoming');
  assert.equal(res.status, 200);
  assert.equal(res.json.offer, null);
});

test('accept with expired offer -> 409 + offer marked expired', async () => {
  const drv = provisionEligibleDriver({ lat: 25.312, lng: 51.512, plate: 'ACE-EXP' });
  const b = await createBooking('accept.exp.cust@example.com');
  const disp = await request('POST', '/api/customer/bookings/' + b.id + '/dispatch');
  assert.equal(disp.json.dispatch.status, 'offer_created');
  const offerId = disp.json.dispatch.offer.id;
  const offeredDriverId = disp.json.dispatch.offer.driver_id;

  db.prepare("UPDATE dispatch_offers SET expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 60000).toISOString(), offerId);

  // Login as the ACTUAL offered driver (regardless of which one it is)
  const offeredDriverUser = db.prepare('SELECT user_id FROM drivers WHERE id = ?').get(offeredDriverId).user_id;
  cookieJar = [driverLoginCookie(offeredDriverUser)];
  const res = await request('POST', '/api/driver/bookings/' + b.id + '/accept');
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'offer_expired');

  const check = db.prepare('SELECT response FROM dispatch_offers WHERE id = ?').get(offerId);
  assert.equal(check.response, 'expired');
});

test('status history recorded for searching -> assigned', async () => {
  const r = db.prepare(
    "SELECT COUNT(*) AS n FROM booking_status_history WHERE from_status = 'searching' AND to_status = 'assigned'"
  ).get();
  assert.ok(r.n >= 1);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
});