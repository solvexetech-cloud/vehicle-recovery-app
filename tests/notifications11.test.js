process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-notif11-'));
process.env.DB_PATH = path.join(tmp, 'notif11.db');
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

async function newCustomer(email) {
  cookieJar = null;
  const reg = await request('POST', '/api/auth/register', {
    body: { role: 'customer', full_name: 'C ' + email, email, password: 'CustPass1234', country_code: 'QA' }
  });
  assert.equal(reg.status, 201, 'register: ' + reg.body);
  await request('GET', '/api/auth/verify-email?token=' + encodeURIComponent(reg.json.dev_verify_token));
  const login = await request('POST', '/api/auth/login', { body: { identifier: email, password: 'CustPass1234' } });
  assert.equal(login.status, 200);
  return login.json.user;
}

function provisionDriver() {
  db.prepare('UPDATE drivers SET is_online = 0').run();
  const userId = db.prepare("INSERT INTO users (country_id, role, full_name, email, password_hash, status, email_verified_at) VALUES (1, 'driver', 'D', ?, 'x', 'active', ?)").run('drv-' + Math.random().toString(36).slice(2) + '@x.co', new Date().toISOString()).lastInsertRowid;
  const agUserId = db.prepare("INSERT INTO users (country_id, role, full_name, email, password_hash, status, email_verified_at) VALUES (1, 'agency', 'A', ?, 'x', 'active', ?)").run('ag-' + Math.random().toString(36).slice(2) + '@x.co', new Date().toISOString()).lastInsertRowid;
  const agId = db.prepare("INSERT INTO agencies (country_id, user_id, legal_name, display_name, status) VALUES (1, ?, 'Ag LLC', 'Ag', 'approved')").run(Number(agUserId)).lastInsertRowid;
  const vId = db.prepare("INSERT INTO recovery_vehicles (country_id, agency_id, plate_number, vehicle_type, status) VALUES (1, ?, 'PL-' || hex(randomblob(3)), 'flatbed', 'approved')").run(Number(agId)).lastInsertRowid;
  const dId = db.prepare("INSERT INTO drivers (country_id, user_id, agency_id, current_vehicle_id, status, is_online, last_gps_lat, last_gps_lng, last_gps_at, approved_at) VALUES (1, ?, ?, ?, 'approved', 1, 25.3005, 51.5005, ?, ?)").run(Number(userId), Number(agId), Number(vId), new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
  db.prepare('INSERT INTO driver_vehicles (driver_id, recovery_vehicle_id) VALUES (?, ?)').run(Number(dId), Number(vId));
  db.prepare("INSERT INTO driver_documents (driver_id, doc_type, file_path, mime_type, size_bytes, expires_at, review_status) VALUES (?, 'driving_license', 'x.png', 'image/png', 100, '2099-01-01', 'approved')").run(Number(dId));
  return { userId: Number(userId), driverId: Number(dId) };
}

test('setup', async () => {
  const ctx = createApp();
  server = ctx.app.listen(0);
  db = ctx.db;
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
  db.prepare("UPDATE country_services SET is_enabled = 1, base_fare_minor = 5000, per_km_minor = 300, fast_surcharge_minor = 1000, min_fare_minor = 8000 WHERE country_id = 1 AND service_code = 'towing'").run();
  db.prepare("UPDATE country_services SET is_enabled = 0 WHERE country_id = 1 AND service_code != 'towing'").run();
});

test('TD-099: customer receives booking.assigned and booking.trip_completed notifications', async () => {
  const cust = await newCustomer('notif-owner@example.com');
  provisionDriver();

  const est = await request('POST', '/api/customer/bookings/estimate', { body: {
    service_type: 'towing', service_level: 'normal',
    pickup: { lat: 25.3, lng: 51.5 }, destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-N11' }
  }});
  const total = est.json.fare_breakdown.total_minor;
  const create = await request('POST', '/api/customer/bookings', { body: {
    service_type: 'towing', service_level: 'normal',
    pickup: { lat: 25.3, lng: 51.5 }, destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-N11' }, agreed_fare_minor: total
  }});
  const booking = create.json.booking;
  const disp = await request('POST', '/api/customer/bookings/' + booking.id + '/dispatch');
  assert.equal(disp.json.dispatch.status, 'offer_created');
  const offeredUserId = db.prepare('SELECT user_id FROM drivers WHERE id = ?').get(disp.json.dispatch.offer.driver_id).user_id;

  // Driver accepts
  cookieJar = [makeSessionCookie(offeredUserId)];
  const acc = await request('POST', '/api/driver/bookings/' + booking.id + '/accept');
  assert.equal(acc.status, 200, 'accept: ' + acc.body);

  // Customer should have booking.assigned notification NOW
  const assignedNotif = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'booking.assigned' AND data_json LIKE ?").get(cust.id, '%"booking_id":' + booking.id + '%').n;
  assert.equal(assignedNotif, 1, 'TD-099: expected 1 booking.assigned notification, got ' + assignedNotif);

  // Continue to complete
  await request('POST', '/api/driver/bookings/' + booking.id + '/on-way');
  await request('POST', '/api/driver/bookings/' + booking.id + '/arrived', { body: { manual_fallback: true, reason: 'test' } });
  await request('POST', '/api/driver/bookings/' + booking.id + '/loaded');
  await request('POST', '/api/driver/bookings/' + booking.id + '/start-trip');
  const comp = await request('POST', '/api/driver/bookings/' + booking.id + '/complete');
  assert.equal(comp.status, 200, 'complete: ' + comp.body);

  // Customer should have booking.trip_completed notification
  const completedNotif = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'booking.trip_completed' AND data_json LIKE ?").get(cust.id, '%"booking_id":' + booking.id + '%').n;
  assert.equal(completedNotif, 1, 'TD-099: expected 1 booking.trip_completed notification, got ' + completedNotif);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
});