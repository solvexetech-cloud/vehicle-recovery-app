process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-agency5-'));
process.env.DB_PATH = path.join(tmp, 'agency5.db');
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

async function loginSuperAdmin() {
  cookieJar = null;
  const pw = process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!';
  const r = await request('POST', '/api/auth/login', { body: { identifier: 'superadmin@vra.local', password: pw } });
  assert.equal(r.status, 200);
}

async function newVerifiedUser(role, email, password, extra = {}) {
  cookieJar = null;
  const reg = await request('POST', '/api/auth/register', {
    body: { role, full_name: 'U ' + email, email, password, country_code: 'QA', ...extra }
  });
  assert.equal(reg.status, 201, 'register failed: ' + reg.body);
  const ver = await request('GET', '/api/auth/verify-email?token=' + encodeURIComponent(reg.json.dev_verify_token));
  assert.equal(ver.status, 200);
  const login = await request('POST', '/api/auth/login', { body: { identifier: email, password } });
  assert.equal(login.status, 200, 'login failed: ' + login.body);
  return login.json.user;
}

// Provision an agency + owner via DB
function provisionAgency({ countryId = 1, status = 'approved', displayName = 'Test Agency' }) {
  const owner = db.prepare(
    "INSERT INTO users (country_id, role, full_name, email, password_hash, status, email_verified_at) " +
    "VALUES (?, 'agency', ?, ?, 'x', 'active', ?)"
  ).run(countryId, displayName + ' Owner', 'agency-' + Math.random().toString(36).slice(2) + '@x.co', new Date().toISOString());
  const agency = db.prepare(
    "INSERT INTO agencies (country_id, user_id, legal_name, display_name, status) VALUES (?, ?, ?, ?, ?)"
  ).run(countryId, Number(owner.lastInsertRowid), displayName + ' LLC', displayName, status);
  return { agencyId: Number(agency.lastInsertRowid), ownerUserId: Number(owner.lastInsertRowid) };
}

// Provision a driver user + driver row tied to agency
function provisionDriver({ countryId = 1, agencyId, status = 'approved' }) {
  const userId = db.prepare(
    "INSERT INTO users (country_id, role, full_name, email, password_hash, status, email_verified_at) " +
    "VALUES (?, 'driver', ?, ?, 'x', 'active', ?)"
  ).run(countryId, 'Test Driver', 'driver-' + Math.random().toString(36).slice(2) + '@x.co', new Date().toISOString()).lastInsertRowid;
  const driverId = db.prepare(
    "INSERT INTO drivers (country_id, user_id, agency_id, status, is_online, approved_at) VALUES (?, ?, ?, ?, 0, ?)"
  ).run(countryId, Number(userId), agencyId, status, new Date().toISOString()).lastInsertRowid;
  return { userId: Number(userId), driverId: Number(driverId) };
}

// Login via password-login route for a pre-provisioned user (agency owner created via DB doesn't have valid hash — so must be set)
function setPasswordForUser(userId, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
}

test('setup: server + super admin + agencies + drivers provisioned', async () => {
  const ctx = createApp();
  server = ctx.app.listen(0);
  db = ctx.db;
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;

  // Create real agency users so we can login
  const A = await newVerifiedUser('agency', 'agency.a@example.com', 'AgencyPass123!', {});
  const B = await newVerifiedUser('agency', 'agency.b@example.com', 'AgencyPass123!', {});
  // agencies rows tied to those user_ids
  const aRow = db.prepare(
    "INSERT INTO agencies (country_id, user_id, legal_name, display_name, status) VALUES (1, ?, 'Agency A LLC', 'Agency A', 'approved')"
  ).run(A.id);
  const bRow = db.prepare(
    "INSERT INTO agencies (country_id, user_id, legal_name, display_name, status) VALUES (1, ?, 'Agency B LLC', 'Agency B', 'approved')"
  ).run(B.id);
  global.__agencyA = { userId: A.id, agencyId: Number(aRow.lastInsertRowid) };
  global.__agencyB = { userId: B.id, agencyId: Number(bRow.lastInsertRowid) };

  // Provision two drivers for agencyA
  const dA1 = provisionDriver({ agencyId: global.__agencyA.agencyId });
  const dA2 = provisionDriver({ agencyId: global.__agencyA.agencyId });
  global.__driverA1 = dA1;
  global.__driverA2 = dA2;

  // One driver for agencyB
  const dB1 = provisionDriver({ agencyId: global.__agencyB.agencyId });
  global.__driverB1 = dB1;
});

test('anonymous /api/agency/profile -> 401', async () => {
  cookieJar = null;
  const res = await request('GET', '/api/agency/profile');
  assert.equal(res.status, 401);
});

test('customer cannot access /api/agency/profile (403)', async () => {
  await newVerifiedUser('customer', 'cust.ag@example.com', 'CustPass1234');
  const res = await request('GET', '/api/agency/profile');
  assert.equal(res.status, 403);
});

test('agencyA GET profile works', async () => {
  await request('POST', '/api/auth/login', { body: { identifier: 'agency.a@example.com', password: 'AgencyPass123!' } });
  const res = await request('GET', '/api/agency/profile');
  assert.equal(res.status, 200);
  assert.equal(res.json.profile.display_name, 'Agency A');
  assert.equal(res.json.profile.status, 'approved');
  assert.equal(res.json.counts.drivers, 2);
  assert.equal(res.json.counts.vehicles, 0);
});

test('agencyA PATCH profile display_name', async () => {
  const res = await request('PATCH', '/api/agency/profile', { body: { display_name: 'Agency A Pro' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.profile.display_name, 'Agency A Pro');
});

test('agencyA PATCH empty body -> 422', async () => {
  const res = await request('PATCH', '/api/agency/profile', { body: {} });
  assert.equal(res.status, 422);
});

test('agencyA add vehicle -> status pending', async () => {
  const res = await request('POST', '/api/agency/vehicles', {
    body: { vehicle_type: 'flatbed', plate_number: 'QA-T1', make: 'Toyota', model: 'Hilux', year: 2023,
            insurance_expires_at: '2027-01-01', inspection_expires_at: '2027-06-01' }
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.vehicle.status, 'pending');
  assert.equal(res.json.vehicle.plate_number, 'QA-T1');
  global.__vehicleA1 = res.json.vehicle.id;
});

test('agencyA duplicate plate in same country -> 409', async () => {
  const res = await request('POST', '/api/agency/vehicles', {
    body: { vehicle_type: 'flatbed', plate_number: 'QA-T1' }
  });
  assert.equal(res.status, 409);
});

test('agencyA invalid vehicle_type -> 422', async () => {
  const res = await request('POST', '/api/agency/vehicles', {
    body: { vehicle_type: 'rocket', plate_number: 'QA-T9' }
  });
  assert.equal(res.status, 422);
});

test('agencyA add second vehicle', async () => {
  const res = await request('POST', '/api/agency/vehicles', {
    body: { vehicle_type: 'wheel_lift', plate_number: 'QA-T2' }
  });
  assert.equal(res.status, 201);
  global.__vehicleA2 = res.json.vehicle.id;
});

test('agencyA approve both vehicles via DB (simulates admin action)', () => {
  db.prepare("UPDATE recovery_vehicles SET status = 'approved' WHERE id IN (?, ?)")
    .run(global.__vehicleA1, global.__vehicleA2);
  const row = db.prepare('SELECT status FROM recovery_vehicles WHERE id = ?').get(global.__vehicleA1);
  assert.equal(row.status, 'approved');
});

test('agencyA PATCH vehicle year + insurance', async () => {
  const res = await request('PATCH', '/api/agency/vehicles/' + global.__vehicleA1, {
    body: { year: 2024, insurance_expires_at: '2028-01-01' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.vehicle.year, 2024);
  assert.equal(res.json.vehicle.insurance_expires_at, '2028-01-01');
});

test('agencyA cannot PATCH status (403)', async () => {
  const res = await request('PATCH', '/api/agency/vehicles/' + global.__vehicleA1, { body: { status: 'approved' } });
  assert.equal(res.status, 403);
});

test('agencyB cannot see agencyA vehicle', async () => {
  await request('POST', '/api/auth/login', { body: { identifier: 'agency.b@example.com', password: 'AgencyPass123!' } });
  const res = await request('PATCH', '/api/agency/vehicles/' + global.__vehicleA1, { body: { year: 2030 } });
  assert.equal(res.status, 404);
});

test('agencyB cannot list agencyA vehicles (only own)', async () => {
  const res = await request('GET', '/api/agency/vehicles');
  assert.equal(res.status, 200);
  assert.equal(res.json.vehicles.length, 0);
});

test('agencyA GET vehicles returns 2 (approved)', async () => {
  await request('POST', '/api/auth/login', { body: { identifier: 'agency.a@example.com', password: 'AgencyPass123!' } });
  const res = await request('GET', '/api/agency/vehicles');
  assert.equal(res.status, 200);
  assert.equal(res.json.vehicles.length, 2);
  assert.equal(res.json.vehicles.every((v) => v.status === 'approved'), true);
});

test('agencyA GET drivers returns 2 with empty authorizations', async () => {
  const res = await request('GET', '/api/agency/drivers');
  assert.equal(res.status, 200);
  assert.equal(res.json.drivers.length, 2);
  for (const d of res.json.drivers) {
    assert.deepEqual(d.authorized_vehicles, []);
  }
});

test('agencyA authorize driverA1 -> vehicleA1', async () => {
  const res = await request('POST', '/api/agency/drivers/' + global.__driverA1.driverId + '/authorize', {
    body: { recovery_vehicle_id: global.__vehicleA1 }
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.ok, true);
});

test('agencyA authorize idempotent (already_authorized)', async () => {
  const res = await request('POST', '/api/agency/drivers/' + global.__driverA1.driverId + '/authorize', {
    body: { recovery_vehicle_id: global.__vehicleA1 }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.already_authorized, true);
});

test('authorizing pending vehicle -> 422', async () => {
  // add a new pending vehicle for agencyA
  const v = await request('POST', '/api/agency/vehicles', { body: { vehicle_type: 'flatbed', plate_number: 'QA-PEND' } });
  assert.equal(v.status, 201);
  const res = await request('POST', '/api/agency/drivers/' + global.__driverA1.driverId + '/authorize', {
    body: { recovery_vehicle_id: v.json.vehicle.id }
  });
  assert.equal(res.status, 422);
});

test('agencyA authorize driverA2 -> vehicleA2', async () => {
  const res = await request('POST', '/api/agency/drivers/' + global.__driverA2.driverId + '/authorize', {
    body: { recovery_vehicle_id: global.__vehicleA2 }
  });
  assert.equal(res.status, 201);
});

test('agencyB cannot authorize agencyA driver (404)', async () => {
  await request('POST', '/api/auth/login', { body: { identifier: 'agency.b@example.com', password: 'AgencyPass123!' } });
  const res = await request('POST', '/api/agency/drivers/' + global.__driverA1.driverId + '/authorize', {
    body: { recovery_vehicle_id: global.__vehicleA2 }
  });
  assert.equal(res.status, 404);
});

test('agencyA GET drivers shows authorizations', async () => {
  await request('POST', '/api/auth/login', { body: { identifier: 'agency.a@example.com', password: 'AgencyPass123!' } });
  const res = await request('GET', '/api/agency/drivers');
  assert.equal(res.status, 200);
  const d1 = res.json.drivers.find((d) => d.id === global.__driverA1.driverId);
  assert.ok(d1);
  assert.equal(d1.authorized_vehicles.length, 1);
  assert.equal(d1.authorized_vehicles[0].recovery_vehicle_id, global.__vehicleA1);
});

test('revoke authorization clears current_vehicle_id', async () => {
  // set driverA1 current_vehicle_id to vehicleA1 first via DB (simulating driver selection)
  db.prepare('UPDATE drivers SET current_vehicle_id = ? WHERE id = ?').run(global.__vehicleA1, global.__driverA1.driverId);

  const res = await request('DELETE', '/api/agency/drivers/' + global.__driverA1.driverId + '/vehicles/' + global.__vehicleA1);
  assert.equal(res.status, 200);

  const drv = db.prepare('SELECT current_vehicle_id FROM drivers WHERE id = ?').get(global.__driverA1.driverId);
  assert.equal(drv.current_vehicle_id, null);
});

test('delete vehicle with active authorization -> 409', async () => {
  // vehicleA2 still authorized for driverA2
  const res = await request('DELETE', '/api/agency/vehicles/' + global.__vehicleA2);
  assert.equal(res.status, 409);
});

test('delete vehicle with no authorization works', async () => {
  // Create a fresh vehicle + authorize nobody, then delete
  const v = await request('POST', '/api/agency/vehicles', { body: { vehicle_type: 'flatbed', plate_number: 'QA-DEL' } });
  assert.equal(v.status, 201);
  db.prepare("UPDATE recovery_vehicles SET status = 'approved' WHERE id = ?").run(v.json.vehicle.id);
  const del = await request('DELETE', '/api/agency/vehicles/' + v.json.vehicle.id);
  assert.equal(del.status, 200);
});

test('agencyB cannot delete agencyA vehicle (404)', async () => {
  await request('POST', '/api/auth/login', { body: { identifier: 'agency.b@example.com', password: 'AgencyPass123!' } });
  const res = await request('DELETE', '/api/agency/vehicles/' + global.__vehicleA2);
  assert.equal(res.status, 404);
});

test('driver cannot access /api/agency/profile (403)', async () => {
  await newVerifiedUser('driver', 'driver.agency-test@example.com', 'DriverPass123!');
  const res = await request('GET', '/api/agency/profile');
  assert.equal(res.status, 403);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
});