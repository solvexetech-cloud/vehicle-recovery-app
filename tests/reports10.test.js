process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-p10-'));
process.env.DB_PATH = path.join(tmp, 'p10.db');
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

function resetAll() {
  db.prepare('UPDATE drivers SET is_online = 0').run();
  db.prepare("UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE status NOT IN ('trip_completed','payment_completed','cancelled','no_driver_available','disputed','payment_failed')").run(new Date().toISOString());
  db.prepare("UPDATE dispatch_offers SET response = 'expired', responded_at = ? WHERE response = 'pending'").run(new Date().toISOString());
  db.prepare("UPDATE users SET status = 'active' WHERE role = 'country_admin' AND country_id = 1").run();
}

function provisionDriver({ plate = 'P10-D' } = {}) {
  resetAll();
  const userId = db.prepare("INSERT INTO users (country_id, role, full_name, email, password_hash, status, email_verified_at) VALUES (1, 'driver', 'Drv', ?, 'x', 'active', ?)").run('drv-' + Math.random().toString(36).slice(2) + '@x.co', new Date().toISOString()).lastInsertRowid;
  const agUserId = db.prepare("INSERT INTO users (country_id, role, full_name, email, password_hash, status, email_verified_at) VALUES (1, 'agency', 'Ag', ?, 'x', 'active', ?)").run('ag-' + Math.random().toString(36).slice(2) + '@x.co', new Date().toISOString()).lastInsertRowid;
  const agId = db.prepare("INSERT INTO agencies (country_id, user_id, legal_name, display_name, status) VALUES (1, ?, 'Ag LLC', 'Ag', 'approved')").run(Number(agUserId)).lastInsertRowid;
  const vId = db.prepare("INSERT INTO recovery_vehicles (country_id, agency_id, plate_number, vehicle_type, status) VALUES (1, ?, ?, 'flatbed', 'approved')").run(Number(agId), plate + '-' + Math.random().toString(36).slice(2, 6)).lastInsertRowid;
  const dId = db.prepare("INSERT INTO drivers (country_id, user_id, agency_id, current_vehicle_id, status, is_online, last_gps_lat, last_gps_lng, last_gps_at, approved_at, rating_avg, rating_count) VALUES (1, ?, ?, ?, 'approved', 1, 25.3005, 51.5005, ?, ?, 4.7, 12)").run(Number(userId), Number(agId), Number(vId), new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
  db.prepare('INSERT INTO driver_vehicles (driver_id, recovery_vehicle_id) VALUES (?, ?)').run(Number(dId), Number(vId));
  db.prepare("INSERT INTO driver_documents (driver_id, doc_type, file_path, mime_type, size_bytes, expires_at, review_status) VALUES (?, 'driving_license', 'x.png', 'image/png', 100, '2099-01-01', 'approved')").run(Number(dId));
  return { userId: Number(userId), driverId: Number(dId), vehicleId: Number(vId) };
}

async function newCustomer(email) {
  cookieJar = null;
  const reg = await request('POST', '/api/auth/register', { body: { role: 'customer', full_name: 'C ' + email, email, password: 'CustPass1234', country_code: 'QA' } });
  assert.equal(reg.status, 201, 'register: ' + reg.body);
  await request('GET', '/api/auth/verify-email?token=' + encodeURIComponent(reg.json.dev_verify_token));
  const login = await request('POST', '/api/auth/login', { body: { identifier: email, password: 'CustPass1234' } });
  assert.equal(login.status, 200);
  return login.json.user;
}

async function makeCompletedBooking(email) {
  const cust = await newCustomer(email);
  const est = await request('POST', '/api/customer/bookings/estimate', { body: { service_type: 'towing', service_level: 'normal', pickup: { lat: 25.3, lng: 51.5 }, destination: { lat: 25.3, lng: 51.55 }, vehicle: { category: 'suv', registration_number: 'QA-R10' } } });
  const total = est.json.fare_breakdown.total_minor;
  const create = await request('POST', '/api/customer/bookings', { body: { service_type: 'towing', service_level: 'normal', pickup: { lat: 25.3, lng: 51.5 }, destination: { lat: 25.3, lng: 51.55 }, vehicle: { category: 'suv', registration_number: 'QA-R10' }, agreed_fare_minor: total } });
  assert.equal(create.status, 201, 'create: ' + create.body);
  const booking = create.json.booking;
  const disp = await request('POST', '/api/customer/bookings/' + booking.id + '/dispatch');
  assert.equal(disp.status, 200);
  assert.equal(disp.json.dispatch.status, 'offer_created', 'dispatch: ' + JSON.stringify(disp.json.dispatch));
  const offeredUserId = db.prepare('SELECT user_id FROM drivers WHERE id = ?').get(disp.json.dispatch.offer.driver_id).user_id;
  cookieJar = [makeSessionCookie(offeredUserId)];
  await request('POST', '/api/driver/bookings/' + booking.id + '/accept');
  await request('POST', '/api/driver/bookings/' + booking.id + '/on-way');
  await request('POST', '/api/driver/bookings/' + booking.id + '/arrived', { body: { manual_fallback: true, reason: 'test' } });
  await request('POST', '/api/driver/bookings/' + booking.id + '/loaded');
  await request('POST', '/api/driver/bookings/' + booking.id + '/start-trip');
  await request('POST', '/api/driver/bookings/' + booking.id + '/complete');
  cookieJar = [makeSessionCookie(cust.id)];
  const pay = await request('POST', '/api/customer/bookings/' + booking.id + '/payment/cash-paid', { body: { amount_minor: total } });
  assert.equal(pay.status, 201, 'pay: ' + pay.body);
  return { booking, customerId: cust.id, driverUserId: offeredUserId, total };
}

test('setup', async () => {
  const ctx = createApp();
  server = ctx.app.listen(0);
  db = ctx.db;
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
  db.prepare("UPDATE country_services SET is_enabled = 1, base_fare_minor = 5000, per_km_minor = 300, fast_surcharge_minor = 1000, min_fare_minor = 8000 WHERE country_id = 1 AND service_code = 'towing'").run();
  db.prepare("UPDATE country_services SET is_enabled = 0 WHERE country_id = 1 AND service_code != 'towing'").run();
  db.prepare("UPDATE country_settings SET tax_rate_bp = 500, commission_rate_bp = 1500 WHERE country_id = 1").run();
  resetAll();
  const pw = process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!';
  cookieJar = null;
  await request('POST', '/api/auth/login', { body: { identifier: 'superadmin@vra.local', password: pw } });
  const mk = await request('POST', '/api/super/country-admins', { body: { email: 'qa.rpt10@example.com', password: 'QaAdminPass123!', full_name: 'QA RPT', country_code: 'QA' } });
  assert.equal(mk.status, 201, 'qa admin: ' + mk.body);
  global.__qaAdminId = mk.json.user.id;
  global.__saAdminId = db.prepare("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1").get().id;
});

test('anonymous -> 401', async () => {
  cookieJar = null;
  assert.equal((await request('GET', '/api/admin/reports/bookings')).status, 401);
  assert.equal((await request('GET', '/api/admin/reports/financials')).status, 401);
  assert.equal((await request('GET', '/api/super/analytics')).status, 401);
});

test('customer -> 403', async () => {
  await newCustomer('rpt-cust@example.com');
  assert.equal((await request('GET', '/api/admin/reports/bookings')).status, 403);
});

test('driver -> 403', async () => {
  const d = provisionDriver({ plate: 'P10-DRV' });
  cookieJar = [makeSessionCookie(d.userId)];
  assert.equal((await request('GET', '/api/admin/reports/bookings')).status, 403);
});

test('provision 2 completed bookings', async () => {
  provisionDriver({ plate: 'P10-B1' });
  global.__b1 = await makeCompletedBooking('rpt1@example.com');
  provisionDriver({ plate: 'P10-B2' });
  global.__b2 = await makeCompletedBooking('rpt2@example.com');
});

test('bookings report lists own country', async () => {
  cookieJar = [makeSessionCookie(global.__qaAdminId)];
  const res = await request('GET', '/api/admin/reports/bookings');
  assert.equal(res.status, 200);
  assert.ok(res.json.total >= 2);
  for (const row of res.json.rows) assert.equal(row.country_id, 1);
});

test('filter status=payment_completed', async () => {
  cookieJar = [makeSessionCookie(global.__qaAdminId)];
  const res = await request('GET', '/api/admin/reports/bookings?status=payment_completed');
  assert.equal(res.status, 200);
  assert.ok(res.json.total >= 2);
  for (const row of res.json.rows) assert.equal(row.status, 'payment_completed');
});

test('financials aggregates', async () => {
  cookieJar = [makeSessionCookie(global.__qaAdminId)];
  const res = await request('GET', '/api/admin/reports/financials');
  assert.equal(res.status, 200);
  const qar = res.json.by_currency.find((x) => x.currency_code === 'QAR');
  assert.ok(qar);
  assert.ok(qar.gross_fare_minor >= global.__b1.total + global.__b2.total);
  assert.equal(qar.commission_minor, Math.round(qar.gross_fare_minor * 1500 / 10000));
  assert.ok(qar.cash_paid_minor >= global.__b1.total + global.__b2.total);
});

test('drivers report with ratings', async () => {
  cookieJar = [makeSessionCookie(global.__qaAdminId)];
  const res = await request('GET', '/api/admin/reports/drivers');
  assert.equal(res.status, 200);
  assert.ok(res.json.drivers.length >= 1);
  assert.ok(res.json.drivers[0].completed >= 1);
  assert.ok(res.json.drivers[0].rating_count >= 1);
});

test('CSV export', async () => {
  cookieJar = [makeSessionCookie(global.__qaAdminId)];
  const res = await request('GET', '/api/admin/reports/bookings.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'] || '', /text\/csv/);
  const lines = res.body.split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 2);
  assert.match(lines[0], /booking_number/);
});

test('invoice endpoint', async () => {
  cookieJar = [makeSessionCookie(global.__b1.customerId)];
  const res = await request('GET', '/api/customer/bookings/' + global.__b1.booking.id + '/invoice');
  assert.equal(res.status, 200, res.body);
  assert.match(res.json.invoice.invoice_number, /^INV-/);
  assert.equal(res.json.invoice.amounts.total_minor, global.__b1.total);
  assert.equal(res.json.invoice.is_paid, true);
  assert.ok(res.json.invoice.amounts.commission_minor > 0);
});

test('invoice isolation', async () => {
  await newCustomer('rpt-intruder@example.com');
  const res = await request('GET', '/api/customer/bookings/' + global.__b1.booking.id + '/invoice');
  assert.equal(res.status, 404);
});

test('super analytics', async () => {
  cookieJar = [makeSessionCookie(global.__saAdminId)];
  const res = await request('GET', '/api/super/analytics');
  assert.equal(res.status, 200);
  assert.equal(res.json.countries.length, 6);
  const qa = res.json.countries.find((c) => c.code === 'QA');
  assert.ok(qa && qa.total_bookings >= 2);
});

test('country_admin blocked from super analytics', async () => {
  cookieJar = [makeSessionCookie(global.__qaAdminId)];
  assert.equal((await request('GET', '/api/super/analytics')).status, 403);
});

test('date range filter', async () => {
  cookieJar = [makeSessionCookie(global.__qaAdminId)];
  const past = '2020-01-01T00:00:00.000Z';
  const future = '2030-01-01T00:00:00.000Z';
  const before = await request('GET', '/api/admin/reports/bookings?from=' + encodeURIComponent(past) + '&to=' + encodeURIComponent(past));
  assert.equal(before.json.total, 0);
  const both = await request('GET', '/api/admin/reports/bookings?from=' + encodeURIComponent(past) + '&to=' + encodeURIComponent(future));
  assert.ok(both.json.total >= 2);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
});