process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-auth-'));
process.env.DB_PATH = path.join(tmp, 'auth.db');

const { createApp } = require('../src/app');

let server, port, cookieJar = null;

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
function cookieHeader() { return cookieJar ? cookieJar.map((c) => c.split(';')[0]).join('; ') : ''; }

function request(method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { host: '127.0.0.1', port, method, path: pathname,
      headers: { 'Content-Type': 'application/json', ...headers } };
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

test('setup server', async () => {
  const { app } = createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
});

test('health ok', async () => {
  const res = await request('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.database, 'ok');
});

test('public countries returns only active (QA)', async () => {
  const res = await request('GET', '/api/countries');
  assert.equal(res.status, 200);
  assert.equal(res.json.countries.length, 1);
  assert.equal(res.json.countries[0].code, 'QA');
});

test('register rejects weak password', async () => {
  const res = await request('POST', '/api/auth/register', {
    body: { role: 'customer', full_name: 'A', email: 'a@b.co', password: 'short', country_code: 'QA' }
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.error, 'validation_error');
});

test('register rejects super_admin public role', async () => {
  const res = await request('POST', '/api/auth/register', {
    body: { role: 'super_admin', full_name: 'X', email: 'x@b.co', password: 'GoodPass123', country_code: 'QA' }
  });
  assert.equal(res.status, 422);
});

test('register bob creates pending user + dev token', async () => {
  const res = await request('POST', '/api/auth/register', {
    body: { role: 'customer', full_name: 'Bob', email: 'bob@example.com', password: 'BobPass1234', country_code: 'QA' }
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.status, 'pending');
  assert.ok(res.json.dev_verify_token);
  assert.ok(res.json.user_id);
});

test('duplicate email returns 409', async () => {
  const res = await request('POST', '/api/auth/register', {
    body: { role: 'customer', full_name: 'Bob2', email: 'BOB@example.com', password: 'BobPass1234', country_code: 'QA' }
  });
  assert.equal(res.status, 409);
});

test('login before verify returns 403 email_not_verified', async () => {
  const res = await request('POST', '/api/auth/login', {
    body: { identifier: 'bob@example.com', password: 'BobPass1234' }
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'forbidden');
});

test('verify email activates user', async () => {
  const reg = await request('POST', '/api/auth/register', {
    body: { role: 'customer', full_name: 'Bob', email: 'bob2@example.com', password: 'BobPass1234', country_code: 'QA' }
  });
  assert.equal(reg.status, 201);
  const token = reg.json.dev_verify_token;
  const ver = await request('GET', '/api/auth/verify-email?token=' + encodeURIComponent(token));
  assert.equal(ver.status, 200);
  assert.equal(ver.json.ok, true);
});

test('login after verify succeeds and sets cookie', async () => {
  const res = await request('POST', '/api/auth/login', {
    body: { identifier: 'bob2@example.com', password: 'BobPass1234' }
  });
  assert.equal(res.status, 200);
  assert.ok(res.headers['set-cookie']);
  assert.equal(res.json.user.email, 'bob2@example.com');
  assert.equal(res.json.user.role, 'customer');
});

test('/me returns user with cookie', async () => {
  const res = await request('GET', '/api/auth/me', { headers: { Cookie: cookieHeader() } });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.email, 'bob2@example.com');
});

test('customer cannot access admin route', async () => {
  const res = await request('GET', '/api/admin/whoami', { headers: { Cookie: cookieHeader() } });
  assert.equal(res.status, 403);
});

test('super admin can access admin route', async () => {
  cookieJar = null;
  const pw = process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!';
  const login = await request('POST', '/api/auth/login', { body: { identifier: 'superadmin@vra.local', password: pw } });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.role, 'super_admin');

  const res = await request('GET', '/api/admin/whoami', { headers: { Cookie: cookieHeader() } });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.role, 'super_admin');
});

test('logout revokes session', async () => {
  const out = await request('POST', '/api/auth/logout', { headers: { Cookie: cookieHeader() } });
  assert.equal(out.status, 200);
  const me = await request('GET', '/api/auth/me', { headers: { Cookie: cookieHeader() } });
  assert.equal(me.status, 401);
});

test('wrong password returns 401', async () => {
  const res = await request('POST', '/api/auth/login', {
    body: { identifier: 'bob2@example.com', password: 'WrongPass123' }
  });
  assert.equal(res.status, 401);
});

test('rate limit triggers after repeated failures', async () => {
  for (let i = 0; i < 4; i++) {
    await request('POST', '/api/auth/login', { body: { identifier: 'bob2@example.com', password: 'WrongPass123' } });
  }
  const res = await request('POST', '/api/auth/login', { body: { identifier: 'bob2@example.com', password: 'WrongPass123' } });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'conflict');
});

test('/me without cookie returns 401', async () => {
  const res = await request('GET', '/api/auth/me');
  assert.equal(res.status, 401);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
});