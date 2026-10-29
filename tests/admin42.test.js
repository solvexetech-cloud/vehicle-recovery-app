process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-admin42-'));
process.env.DB_PATH = path.join(tmp, 'admin42.db');

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

async function login(email, password) {
  cookieJar = null;
  const res = await request('POST', '/api/auth/login', { body: { identifier: email, password } });
  return res;
}

test('setup: server, super admin, activate SA, create QA + SA admins', async () => {
  const ctx = createApp();
  server = ctx.app.listen(0);
  db = ctx.db;
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;

  const pw = process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!';
  const sa = await login('superadmin@vra.local', pw);
  assert.equal(sa.status, 200);

  const activate = await request('PATCH', '/api/super/countries/SA', { body: { is_active: true } });
  assert.equal(activate.status, 200);

  const mk = (email, p, full_name, code) => request('POST', '/api/super/country-admins', {
    body: { email, password: p, full_name, country_code: code }
  });
  const qa = await mk('qa-admin@example.com', 'QaAdminPass123!', 'QA Admin', 'QA');
  assert.equal(qa.status, 201);
  const saA = await mk('sa-admin@example.com', 'SaAdminPass123!', 'SA Admin', 'SA');
  assert.equal(saA.status, 201);
});

test('QA admin GET /api/admin/country returns QA', async () => {
  await login('qa-admin@example.com', 'QaAdminPass123!');
  const res = await request('GET', '/api/admin/country');
  assert.equal(res.status, 200);
  assert.equal(res.json.country.code, 'QA');
  assert.equal(res.json.services.length, 8);
});

test('SA admin GET /api/admin/country returns SA', async () => {
  await login('sa-admin@example.com', 'SaAdminPass123!');
  const res = await request('GET', '/api/admin/country');
  assert.equal(res.status, 200);
  assert.equal(res.json.country.code, 'SA');
});

test('QA admin updates own settings (tax_rate_bp=1500)', async () => {
  await login('qa-admin@example.com', 'QaAdminPass123!');
  const res = await request('PATCH', '/api/admin/country/settings', { body: { tax_rate_bp: 1500, tax_label: 'VAT15' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.settings.tax_rate_bp, 1500);
  assert.equal(res.json.settings.tax_label, 'VAT15');
});

test('SA settings remain at defaults (500) after QA update', async () => {
  await login('sa-admin@example.com', 'SaAdminPass123!');
  const res = await request('GET', '/api/admin/country');
  assert.equal(res.status, 200);
  assert.equal(res.json.settings.tax_rate_bp, 500);
});

test('SA admin updates own settings (tax_rate_bp=2000)', async () => {
  const res = await request('PATCH', '/api/admin/country/settings', { body: { tax_rate_bp: 2000 } });
  assert.equal(res.status, 200);
  assert.equal(res.json.settings.tax_rate_bp, 2000);
});

test('QA still 1500, SA now 2000', async () => {
  await login('qa-admin@example.com', 'QaAdminPass123!');
  let res = await request('GET', '/api/admin/country');
  assert.equal(res.json.settings.tax_rate_bp, 1500);

  await login('sa-admin@example.com', 'SaAdminPass123!');
  res = await request('GET', '/api/admin/country');
  assert.equal(res.json.settings.tax_rate_bp, 2000);
});

test('QA admin cannot override country_id via body (403)', async () => {
  await login('qa-admin@example.com', 'QaAdminPass123!');
  const res = await request('PATCH', '/api/admin/country/settings', {
    body: { tax_rate_bp: 9999, country_id: 999 }
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'cross_country_forbidden');
  // verify QA unchanged (still 1500)
  const check = await request('GET', '/api/admin/country');
  assert.equal(check.json.settings.tax_rate_bp, 1500);
});

test('QA admin enable/disable own service', async () => {
  const res = await request('PATCH', '/api/admin/country/services/towing', { body: { is_enabled: 0 } });
  assert.equal(res.status, 200);
  assert.equal(res.json.service.is_enabled, 0);
  const reEnable = await request('PATCH', '/api/admin/country/services/towing', { body: { is_enabled: 1 } });
  assert.equal(reEnable.json.service.is_enabled, 1);
});

test('QA admin updates service pricing', async () => {
  const res = await request('PATCH', '/api/admin/country/services/towing', {
    body: { base_fare_minor: 5000, per_km_minor: 300, min_fare_minor: 1000 }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.service.base_fare_minor, 5000);
  assert.equal(res.json.service.per_km_minor, 300);
});

test('SA service pricing unchanged by QA update', async () => {
  await login('sa-admin@example.com', 'SaAdminPass123!');
  const res = await request('GET', '/api/admin/country');
  const towing = res.json.services.find((s) => s.service_code === 'towing');
  assert.equal(towing.base_fare_minor, 0);
});

test('QA admin invalid service code -> 422', async () => {
  await login('qa-admin@example.com', 'QaAdminPass123!');
  const res = await request('PATCH', '/api/admin/country/services/nonsense', { body: { is_enabled: 1 } });
  assert.equal(res.status, 422);
});

test('QA admin invalid value -> 422', async () => {
  const res = await request('PATCH', '/api/admin/country/settings', { body: { tax_rate_bp: 99999 } });
  assert.equal(res.status, 422);
});

test('QA admin empty body -> 422', async () => {
  const res = await request('PATCH', '/api/admin/country/settings', { body: {} });
  assert.equal(res.status, 422);
});

test('customer cannot access /api/admin/country (403)', async () => {
  cookieJar = null;
  const reg = await request('POST', '/api/auth/register', {
    body: { role: 'customer', full_name: 'Cust', email: 'cust42@example.com', password: 'CustPass123!', country_code: 'QA' }
  });
  assert.equal(reg.status, 201);
  const verify = await request('GET', '/api/auth/verify-email?token=' + encodeURIComponent(reg.json.dev_verify_token));
  assert.equal(verify.status, 200);
  await login('cust42@example.com', 'CustPass123!');
  const res = await request('GET', '/api/admin/country');
  assert.equal(res.status, 403);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
});