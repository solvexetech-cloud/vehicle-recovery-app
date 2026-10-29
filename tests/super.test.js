process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-super-'));
process.env.DB_PATH = path.join(tmp, 'super.db');

const { createApp } = require('../src/app');

let server, port, db, cookieJar = null;

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
function cookieHeader() { return cookieJar ? cookieJar.map((c) => c.split(';')[0]).join('; ') : ''; }

function request(method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const hdrs = { 'Content-Type': 'application/json', ...headers };
    if (cookieJar && !hdrs['Cookie']) {
      hdrs['Cookie'] = cookieJar.map((c) => c.split(';')[0]).join('; ');
    }
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
  const res = await request('POST', '/api/auth/login', { body: { identifier: 'superadmin@vra.local', password: pw } });
  assert.equal(res.status, 200);
}

test('setup', async () => {
  const ctx = createApp();
  server = ctx.app.listen(0);
  db = ctx.db;
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
});

test('boot: 6 countries, 6 settings, 48 service rows, QA has 2 enabled', () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM countries').get().n, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM country_settings').get().n, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM country_services').get().n, 48);
  const qaEnabled = db.prepare(
    "SELECT s.service_code FROM country_services s JOIN countries c ON c.id = s.country_id WHERE c.code = 'QA' AND s.is_enabled = 1 ORDER BY s.service_code"
  ).all().map((r) => r.service_code);
  assert.deepEqual(qaEnabled, ['jump_start', 'towing']);
});

test('anonymous cannot access /api/super/countries (401)', async () => {
  cookieJar = null;
  const res = await request('GET', '/api/super/countries');
  assert.equal(res.status, 401);
});

test('super admin lists 6 countries, QA active, 5 inactive', async () => {
  await loginSuperAdmin();
  const res = await request('GET', '/api/super/countries');
  assert.equal(res.status, 200);
  assert.equal(res.json.countries.length, 6);
  const qa = res.json.countries.find((c) => c.code === 'QA');
  assert.equal(qa.is_active, 1);
  assert.equal(qa.services_enabled, 2);
  assert.equal(res.json.countries.filter((c) => c.is_active === 0).length, 5);
});

test('super admin gets QA details with 8 services (2 enabled)', async () => {
  const res = await request('GET', '/api/super/countries/QA');
  assert.equal(res.status, 200);
  assert.equal(res.json.country.code, 'QA');
  assert.equal(res.json.settings.tax_rate_bp, 500);
  assert.equal(res.json.services.length, 8);
  const enabled = res.json.services.filter((s) => s.is_enabled === 1).map((s) => s.service_code).sort();
  assert.deepEqual(enabled, ['jump_start', 'towing']);
});

test('activate SA, then deactivate back', async () => {
  let res = await request('PATCH', '/api/super/countries/SA', { body: { is_active: true } });
  assert.equal(res.status, 200);
  assert.equal(res.json.country.is_active, 1);
  res = await request('PATCH', '/api/super/countries/SA', { body: { is_active: false } });
  assert.equal(res.status, 200);
  assert.equal(res.json.country.is_active, 0);
});

test('PATCH empty body -> 422', async () => {
  const res = await request('PATCH', '/api/super/countries/QA', { body: {} });
  assert.equal(res.status, 422);
});

test('PATCH nonexistent country -> 404', async () => {
  const res = await request('PATCH', '/api/super/countries/ZZ', { body: { is_active: true } });
  assert.equal(res.status, 404);
});

test('create country XX gets 8 services (all disabled)', async () => {
  const res = await request('POST', '/api/super/countries', { body: {
    code: 'XX', name_en: 'Testland', name_ar: 'Test', currency_code: 'XXX',
    currency_symbol: 'X$', dial_code: '+999', timezone: 'UTC'
  }});
  assert.equal(res.status, 201);
  assert.equal(res.json.country.code, 'XX');
  assert.equal(res.json.country.is_active, 0);

  const detail = await request('GET', '/api/super/countries/XX');
  assert.equal(detail.status, 200);
  assert.equal(detail.json.services.length, 8);
  assert.equal(detail.json.services.every((s) => s.is_enabled === 0), true);
});

test('duplicate country code -> 409', async () => {
  const res = await request('POST', '/api/super/countries', { body: {
    code: 'QA', name_en: 'Dup', currency_code: 'QAR', currency_symbol: 'Q', dial_code: '+974', timezone: 'UTC'
  }});
  assert.equal(res.status, 409);
});

test('create country admin for QA', async () => {
  const res = await request('POST', '/api/super/country-admins', { body: {
    email: 'qaadmin@example.com', password: 'QaAdminPass123!', full_name: 'QA Admin', country_code: 'QA'
  }});
  assert.equal(res.status, 201);
  assert.equal(res.json.user.role, 'country_admin');
  assert.equal(res.json.user.country_code, 'QA');
  assert.equal(res.json.user.status, 'active');
});

test('new country admin can log in', async () => {
  cookieJar = null;
  const login = await request('POST', '/api/auth/login', { body: {
    identifier: 'qaadmin@example.com', password: 'QaAdminPass123!'
  }});
  assert.equal(login.status, 200);
  assert.equal(login.json.user.role, 'country_admin');
});

test('country admin cannot access /api/super routes (403)', async () => {
  const res = await request('GET', '/api/super/countries');
  assert.equal(res.status, 403);
});

test('country admin cannot create country admins (403)', async () => {
  const res = await request('POST', '/api/super/country-admins', { body: {
    email: 'evil@example.com', password: 'EvilPass123!', full_name: 'Evil', country_code: 'QA'
  }});
  assert.equal(res.status, 403);
});

test('duplicate country admin email -> 409', async () => {
  await loginSuperAdmin();
  const res = await request('POST', '/api/super/country-admins', { body: {
    email: 'qaadmin@example.com', password: 'AnotherPass123!', full_name: 'Dup', country_code: 'SA'
  }});
  assert.equal(res.status, 409);
});

test('weak password -> 422', async () => {
  const res = await request('POST', '/api/super/country-admins', { body: {
    email: 'weak@example.com', password: 'short', full_name: 'Weak', country_code: 'QA'
  }});
  assert.equal(res.status, 422);
});

test('invalid country code -> 422', async () => {
  const res = await request('POST', '/api/super/country-admins', { body: {
    email: 'bad@example.com', password: 'GoodPass123!', full_name: 'Bad', country_code: 'ZZ'
  }});
  assert.equal(res.status, 422);
});

test('list country admins includes qaadmin', async () => {
  const res = await request('GET', '/api/super/country-admins');
  assert.equal(res.status, 200);
  assert.ok(res.json.country_admins.some((a) => a.email === 'qaadmin@example.com'));
});

test('suspend qaadmin -> sessions revoked, login 403', async () => {
  const list = await request('GET', '/api/super/country-admins');
  const qaadmin = list.json.country_admins.find((a) => a.email === 'qaadmin@example.com');
  const res = await request('PATCH', '/api/super/country-admins/' + qaadmin.id, { body: { status: 'suspended' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.status, 'suspended');

  cookieJar = null;
  const login = await request('POST', '/api/auth/login', { body: {
    identifier: 'qaadmin@example.com', password: 'QaAdminPass123!'
  }});
  assert.equal(login.status, 403);
});

test('PATCH country admin invalid status -> 422', async () => {
  await loginSuperAdmin();
  const list = await request('GET', '/api/super/country-admins');
  const qaadmin = list.json.country_admins.find((a) => a.email === 'qaadmin@example.com');
  const res = await request('PATCH', '/api/super/country-admins/' + qaadmin.id, { body: { status: 'weird' } });
  assert.equal(res.status, 422);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
});