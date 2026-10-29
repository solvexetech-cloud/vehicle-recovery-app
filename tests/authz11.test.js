process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-authz11-'));
process.env.DB_PATH = path.join(tmp, 'authz11.db');
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

function provisionAgencyOwner() {
  const userId = db.prepare("INSERT INTO users (country_id, role, full_name, email, password_hash, status, email_verified_at) VALUES (1, 'agency', 'AO', ?, 'x', 'active', ?)").run('aown-' + Math.random().toString(36).slice(2) + '@x.co', new Date().toISOString()).lastInsertRowid;
  const agId = db.prepare("INSERT INTO agencies (country_id, user_id, legal_name, display_name, status) VALUES (1, ?, 'Own LLC', 'Own', 'approved')").run(Number(userId)).lastInsertRowid;
  return { userId: Number(userId), agencyId: Number(agId) };
}

let ctxRef = null;
let tokenHolder = {};

test('setup', async () => {
  const ctx = createApp();
  server = ctx.app.listen(0);
  db = ctx.db;
  ctxRef = ctx;
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;

  db.prepare("UPDATE country_services SET is_enabled = 1, base_fare_minor = 5000, per_km_minor = 300, fast_surcharge_minor = 1000, min_fare_minor = 8000 WHERE country_id = 1 AND service_code = 'towing'").run();
  db.prepare("UPDATE country_services SET is_enabled = 0 WHERE country_id = 1 AND service_code != 'towing'").run();

  const pw = process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!';
  cookieJar = null;
  await request('POST', '/api/auth/login', { body: { identifier: 'superadmin@vra.local', password: pw } });
  const mk = await request('POST', '/api/super/country-admins', {
    body: { email: 'authz-admin@example.com', password: 'QaAdminPass123!', full_name: 'Authz Admin', country_code: 'QA' }
  });
  assert.equal(mk.status, 201, mk.body);
  tokenHolder.qaAdminId = mk.json.user.id;
  tokenHolder.saAdminId = db.prepare("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1").get().id;

  const c = await newCustomer('authz-cust@example.com');
  tokenHolder.customerId = c.id;

  const d = provisionDriver();
  tokenHolder.driverId = d.driverId;
  tokenHolder.driverUserId = d.userId;

  const a = provisionAgencyOwner();
  tokenHolder.agencyId = a.agencyId;
  tokenHolder.agencyUserId = a.userId;
});

// ---- Role × Endpoint authorization matrix ----

const SENSITIVE_ENDPOINTS = [
  // path, method, expected for each role when unauthorized
  { path: '/api/admin/country',                       method: 'GET',  roles: { customer: 403, driver: 403, agency: 403, country_admin: 200, super_admin: 403 } },
  { path: '/api/admin/reports/bookings',              method: 'GET',  roles: { customer: 403, driver: 403, agency: 403, country_admin: 200, super_admin: 200 } },
  { path: '/api/admin/reports/financials',            method: 'GET',  roles: { customer: 403, driver: 403, agency: 403, country_admin: 200, super_admin: 200 } },
  { path: '/api/admin/reports/drivers',               method: 'GET',  roles: { customer: 403, driver: 403, agency: 403, country_admin: 200, super_admin: 200 } },
  { path: '/api/super/countries',                     method: 'GET',  roles: { customer: 403, driver: 403, agency: 403, country_admin: 403, super_admin: 200 } },
  { path: '/api/super/country-admins',                method: 'GET',  roles: { customer: 403, driver: 403, agency: 403, country_admin: 403, super_admin: 200 } },
  { path: '/api/super/analytics',                     method: 'GET',  roles: { customer: 403, driver: 403, agency: 403, country_admin: 403, super_admin: 200 } },
  { path: '/api/customer/profile',                    method: 'GET',  roles: { customer: 200, driver: 403, agency: 403, country_admin: 403, super_admin: 403 } },
  { path: '/api/customer/vehicles',                   method: 'GET',  roles: { customer: 200, driver: 403, agency: 403, country_admin: 403, super_admin: 403 } },
  { path: '/api/customer/destinations',               method: 'GET',  roles: { customer: 200, driver: 403, agency: 403, country_admin: 403, super_admin: 403 } },
  { path: '/api/driver/profile',                      method: 'GET',  roles: { customer: 403, driver: 200, agency: 403, country_admin: 403, super_admin: 403 } },
  { path: '/api/driver/vehicles',                     method: 'GET',  roles: { customer: 403, driver: 200, agency: 403, country_admin: 403, super_admin: 403 } },
  { path: '/api/driver/documents',                    method: 'GET',  roles: { customer: 403, driver: 200, agency: 403, country_admin: 403, super_admin: 403 } },
  { path: '/api/agency/profile',                      method: 'GET',  roles: { customer: 403, driver: 403, agency: 200, country_admin: 403, super_admin: 403 } },
  { path: '/api/agency/vehicles',                     method: 'GET',  roles: { customer: 403, driver: 403, agency: 200, country_admin: 403, super_admin: 403 } },
  { path: '/api/agency/drivers',                      method: 'GET',  roles: { customer: 403, driver: 403, agency: 200, country_admin: 403, super_admin: 403 } },
];

for (const ep of SENSITIVE_ENDPOINTS) {
  for (const role of ['customer', 'driver', 'agency', 'country_admin', 'super_admin']) {
    const expected = ep.roles[role];
    test(`role=${role} ${ep.method} ${ep.path} -> ${expected}`, async () => {
      cookieJar = null;
      let userId = null;
      if (role === 'customer') userId = tokenHolder.customerId;
      else if (role === 'driver') userId = tokenHolder.driverUserId;
      else if (role === 'agency') userId = tokenHolder.agencyUserId;
      else if (role === 'country_admin') userId = tokenHolder.qaAdminId;
      else if (role === 'super_admin') userId = tokenHolder.saAdminId;

      if (userId) cookieJar = [makeSessionCookie(userId)];
      const res = await request(ep.method, ep.path);
      assert.equal(res.status, expected, `role=${role} ${ep.method} ${ep.path} expected ${expected}, got ${res.status} body=${res.body}`);
    });
  }
}

test('anonymous access to every sensitive endpoint -> 401', async () => {
  cookieJar = null;
  for (const ep of SENSITIVE_ENDPOINTS) {
    const res = await request(ep.method, ep.path);
    assert.equal(res.status, 401, `anonymous ${ep.method} ${ep.path} expected 401, got ${res.status}`);
  }
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
});