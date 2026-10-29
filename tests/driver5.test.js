process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-driver5-'));
process.env.DB_PATH = path.join(tmp, 'driver5.db');
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

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function loginSuperAdmin() {
  cookieJar = null;
  const pw = process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!';
  const r = await request('POST', '/api/auth/login', { body: { identifier: 'superadmin@vra.local', password: pw } });
  assert.equal(r.status, 200);
}

async function createDriverUser(email, password) {
  cookieJar = null;
  const reg = await request('POST', '/api/auth/register', {
    body: { role: 'driver', full_name: 'Driver ' + email, email, password, country_code: 'QA' }
  });
  assert.equal(reg.status, 201, 'register failed: ' + reg.body);
  const ver = await request('GET', '/api/auth/verify-email?token=' + encodeURIComponent(reg.json.dev_verify_token));
  assert.equal(ver.status, 200);
  const login = await request('POST', '/api/auth/login', { body: { identifier: email, password } });
  assert.equal(login.status, 200, 'login failed: ' + login.body);
  return login.json.user;
}

// Manually provision driver + agency + vehicle + authorization via DB
function provisionDriverViaDb({ userId, countryId = 1, agencyId = null, status = 'approved',
                                vehicleStatus = 'approved', withAuth = true }) {
  const driverRow = db.prepare(
    "INSERT INTO drivers (country_id, user_id, agency_id, status, is_online, approved_at) VALUES (?, ?, ?, ?, 0, ?)"
  ).run(countryId, userId, agencyId, status, new Date().toISOString());
  const driverId = Number(driverRow.lastInsertRowid);
  let vehicleId = null;
  if (agencyId) {
    const rv = db.prepare(
      "INSERT INTO recovery_vehicles (country_id, agency_id, plate_number, vehicle_type, status) VALUES (?, ?, ?, 'flatbed', ?)"
    ).run(countryId, agencyId, 'PL-' + userId + '-' + Math.random().toString(36).slice(2, 6), vehicleStatus);
    vehicleId = Number(rv.lastInsertRowid);
    if (withAuth) {
      db.prepare("INSERT INTO driver_vehicles (driver_id, recovery_vehicle_id) VALUES (?, ?)").run(driverId, vehicleId);
    }
  }
  return { driverId, vehicleId };
}

test('setup: server, super admin, country admin, agency', async () => {
  const ctx = createApp();
  server = ctx.app.listen(0);
  db = ctx.db;
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;

  await loginSuperAdmin();
  const mk = await request('POST', '/api/super/country-admins', {
    body: { email: 'qa.drv.admin@example.com', password: 'QaAdminPass123!', full_name: 'QA Admin', country_code: 'QA' }
  });
  assert.equal(mk.status, 201);

  // Create an agency user + agency row directly (agency endpoints come in a later phase)
  const agencyUser = db.prepare(
    "INSERT INTO users (country_id, role, full_name, email, password_hash, status, email_verified_at) " +
    "VALUES (1, 'agency', 'Agency Owner', 'agency1@example.com', 'x', 'active', ?)"
  ).run(new Date().toISOString()).lastInsertRowid;
  const agency = db.prepare(
    "INSERT INTO agencies (country_id, user_id, legal_name, display_name, status) VALUES (1, ?, 'Agency1 LLC', 'Agency1', 'approved')"
  ).run(Number(agencyUser));
  global.__agencyId = Number(agency.lastInsertRowid);
});

test('driverA GET /profile works; eligibility false initially', async () => {
  const user = await createDriverUser('drv.a@example.com', 'DriverPass1234');
  const prov = provisionDriverViaDb({ userId: user.id, agencyId: global.__agencyId });
  global.__driverA = { userId: user.id, driverId: prov.driverId, vehicleId: prov.vehicleId };

  const res = await request('GET', '/api/driver/profile');
  assert.equal(res.status, 200);
  assert.equal(res.json.driver.status, 'approved');
  assert.equal(res.json.eligibility.eligible, false);
  assert.ok(res.json.eligibility.reasons.includes('missing_required_document:driving_license'));
  assert.ok(res.json.eligibility.reasons.includes('no_vehicle_selected'));
  assert.ok(res.json.eligibility.reasons.includes('gps_missing'));
  assert.ok(res.json.eligibility.reasons.includes('driver_offline'));
});

test('driverA PATCH profile phone', async () => {
  const res = await request('PATCH', '/api/driver/profile', { body: { phone: '+97411112222' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.profile.phone, '+97411112222');
});

test('driverA GET /vehicles lists authorized vehicle', async () => {
  const res = await request('GET', '/api/driver/vehicles');
  assert.equal(res.status, 200);
  assert.equal(res.json.vehicles.length, 1);
  assert.equal(res.json.vehicles[0].id, global.__driverA.vehicleId);
});

test('driverA cannot set current vehicle that is not authorized', async () => {
  // create another vehicle in same agency but do not authorize
  const rv = db.prepare(
    "INSERT INTO recovery_vehicles (country_id, agency_id, plate_number, vehicle_type, status) VALUES (1, ?, 'PL-EXTRA', 'flatbed', 'approved')"
  ).run(global.__agencyId);
  const unauthId = Number(rv.lastInsertRowid);
  const res = await request('POST', '/api/driver/current-vehicle', { body: { recovery_vehicle_id: unauthId } });
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'forbidden');
});

test('driverA set current vehicle (authorized)', async () => {
  const res = await request('POST', '/api/driver/current-vehicle', { body: { recovery_vehicle_id: global.__driverA.vehicleId } });
  assert.equal(res.status, 200);
  assert.equal(res.json.current_vehicle_id, global.__driverA.vehicleId);
});

test('driverA cannot go online yet (missing driving_license + gps)', async () => {
  const res = await request('POST', '/api/driver/status', { body: { is_online: true } });
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'forbidden');
  const msg = String(res.json.message || '');
  assert.match(msg, /not_eligible_online/);
  assert.match(msg, /missing_required_document:driving_license/);
});

test('driverA upload invalid mime -> 422', async () => {
  const res = await request('POST', '/api/driver/documents', {
    body: { doc_type: 'driving_license', data_url: 'data:application/zip;base64,AAAA' }
  });
  assert.equal(res.status, 422);
});

test('driverA upload too-large file -> 422', async () => {
  const big = Buffer.alloc(2 * 1024 * 1024 + 100, 0);
  const dataUrl = 'data:image/png;base64,' + big.toString('base64');
  const res = await request('POST', '/api/driver/documents', {
    body: { doc_type: 'driving_license', data_url: dataUrl }
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.details?.reason || res.json.details?.error || res.json.error, 'validation_error');
});

test('driverA upload driving_license (valid PNG)', async () => {
  const res = await request('POST', '/api/driver/documents', {
    body: { doc_type: 'driving_license', data_url: TINY_PNG, expires_at: '2099-12-31' }
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.document.doc_type, 'driving_license');
  assert.equal(res.json.document.review_status, 'pending');
  global.__docA = res.json.document.id;
});

test('driverA GET /documents returns 1', async () => {
  const res = await request('GET', '/api/driver/documents');
  assert.equal(res.status, 200);
  assert.equal(res.json.documents.length, 1);
});

test('approve driving_license in DB -> eligibility no longer missing document', async () => {
  db.prepare("UPDATE driver_documents SET review_status = 'approved' WHERE id = ?").run(global.__docA);
  const res = await request('GET', '/api/driver/eligibility');
  assert.equal(res.status, 200);
  assert.ok(!res.json.reasons.includes('missing_required_document:driving_license'));
});

test('driverA sets GPS', async () => {
  const res = await request('POST', '/api/driver/location', { body: { lat: 25.3, lng: 51.5 } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
});

test('driverA eligibility now only missing driver_offline', async () => {
  const res = await request('GET', '/api/driver/eligibility');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.reasons, ['driver_offline']);
});

test('driverA goes online', async () => {
  const res = await request('POST', '/api/driver/status', { body: { is_online: true } });
  assert.equal(res.status, 200);
  assert.equal(res.json.is_online, true);
  const elig = await request('GET', '/api/driver/eligibility');
  assert.equal(elig.json.eligible, true);
});

test('driverA goes offline', async () => {
  const res = await request('POST', '/api/driver/status', { body: { is_online: false } });
  assert.equal(res.status, 200);
  assert.equal(res.json.is_online, false);
});

test('driverB (no docs) cannot go online', async () => {
  const user = await createDriverUser('drv.b@example.com', 'DriverPass1234');
  const prov = provisionDriverViaDb({ userId: user.id, agencyId: global.__agencyId });
  await request('POST', '/api/driver/current-vehicle', { body: { recovery_vehicle_id: prov.vehicleId } });
  await request('POST', '/api/driver/location', { body: { lat: 25.3, lng: 51.5 } });
  const res = await request('POST', '/api/driver/status', { body: { is_online: true } });
  assert.equal(res.status, 403);
});

test('isolation: driverA cannot delete driverB document (404)', async () => {
  // Create driverB doc directly
  const driverBRow = db.prepare("SELECT d.id FROM drivers d JOIN users u ON u.id = d.user_id WHERE u.email = 'drv.b@example.com'").get();
  const docRow = db.prepare(
    "INSERT INTO driver_documents (driver_id, doc_type, file_path, mime_type, size_bytes, review_status) VALUES (?, 'national_id', 'fake/path.pdf', 'application/pdf', 100, 'pending')"
  ).run(driverBRow.id);
  const docBId = Number(docRow.lastInsertRowid);

  // login as driverA
  await request('POST', '/api/auth/login', { body: { identifier: 'drv.a@example.com', password: 'DriverPass1234' } });
  const res = await request('DELETE', '/api/driver/documents/' + docBId);
  assert.equal(res.status, 404);
});

test('driverA delete own document removes file and row', async () => {
  const res = await request('DELETE', '/api/driver/documents/' + global.__docA);
  assert.equal(res.status, 200);
  const list = await request('GET', '/api/driver/documents');
  assert.equal(list.json.documents.length, 0);
});

test('customer cannot access /api/driver/profile (403)', async () => {
  cookieJar = null;
  const reg = await request('POST', '/api/auth/register', {
    body: { role: 'customer', full_name: 'Cust X', email: 'cust5.2@example.com', password: 'CustPass1234', country_code: 'QA' }
  });
  assert.equal(reg.status, 201);
  await request('GET', '/api/auth/verify-email?token=' + encodeURIComponent(reg.json.dev_verify_token));
  await request('POST', '/api/auth/login', { body: { identifier: 'cust5.2@example.com', password: 'CustPass1234' } });
  const res = await request('GET', '/api/driver/profile');
  assert.equal(res.status, 403);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
});