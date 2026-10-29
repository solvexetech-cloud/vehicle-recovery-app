process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-mfa42-'));
process.env.DB_PATH = path.join(tmp, 'mfa42.db');

const { createApp } = require('../src/app');
const { computeTotp, verifyTotp, base32Encode, base32Decode } = require('../src/mfa/totp');

let server, port, cookieJar = null;
let superSecret = null;

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

// ---- RFC 6238 unit tests ----
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32("12345678901234567890")

test('TOTP RFC 6238 vector at T=59 (94287082)', () => {
  assert.equal(computeTotp(RFC_SECRET, { time: 59000, digits: 8 }), '94287082');
});

test('TOTP RFC 6238 vector at T=1111111109 (07081804)', () => {
  assert.equal(computeTotp(RFC_SECRET, { time: 1111111109000, digits: 8 }), '07081804');
});

test('TOTP RFC 6238 vector at T=1111111111 (14050471)', () => {
  assert.equal(computeTotp(RFC_SECRET, { time: 1111111111000, digits: 8 }), '14050471');
});

test('TOTP RFC 6238 vector at T=1234567890 (89005924)', () => {
  assert.equal(computeTotp(RFC_SECRET, { time: 1234567890000, digits: 8 }), '89005924');
});

test('TOTP RFC 6238 vector at T=2000000000 (69279037)', () => {
  assert.equal(computeTotp(RFC_SECRET, { time: 2000000000000, digits: 8 }), '69279037');
});

test('TOTP RFC 6238 vector at T=20000000000 (65353130)', () => {
  assert.equal(computeTotp(RFC_SECRET, { time: 20000000000000, digits: 8 }), '65353130');
});

test('base32 roundtrip', () => {
  const buf = Buffer.from('Hello, world!');
  assert.deepEqual(base32Decode(base32Encode(buf)), buf);
});

test('verifyTotp accepts current code, rejects wrong, rejects wrong length', () => {
  const s = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const now = 1700000000000;
  const code = computeTotp(s, { time: now, digits: 6 });
  assert.equal(verifyTotp(s, code, { time: now, window: 1 }), true);
  assert.equal(verifyTotp(s, '000000', { time: now, window: 0 }), false);
  assert.equal(verifyTotp(s, '12345', { time: now, window: 1 }), false);
  assert.equal(verifyTotp(s, 'abcdef', { time: now, window: 1 }), false);
});

// ---- Integration: full MFA lifecycle ----
test('setup: server + super admin login without MFA', async () => {
  const ctx = createApp();
  server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;

  cookieJar = null;
  const pw = process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!';
  const res = await request('POST', '/api/auth/login', { body: { identifier: 'superadmin@vra.local', password: pw } });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.mfa_enabled, false);
});

test('anonymous cannot enroll MFA (401)', async () => {
  cookieJar = null;
  const res = await request('POST', '/api/auth/mfa/enroll');
  assert.equal(res.status, 401);
});

test('enroll MFA returns secret + otpauth_url', async () => {
  cookieJar = null;
  const pw = process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!';
  await request('POST', '/api/auth/login', { body: { identifier: 'superadmin@vra.local', password: pw } });

  const res = await request('POST', '/api/auth/mfa/enroll');
  assert.equal(res.status, 200);
  assert.equal(res.json.enabled, false);
  assert.ok(res.json.secret);
  assert.ok(res.json.otpauth_url);
  assert.match(res.json.otpauth_url, /^otpauth:\/\/totp\//);
  superSecret = res.json.secret;
});

test('enroll again after pending -> 200 (regenerates)', async () => {
  const res = await request('POST', '/api/auth/mfa/enroll');
  assert.equal(res.status, 200);
  assert.ok(res.json.secret);
  superSecret = res.json.secret;
});

test('confirm with wrong code -> 401 invalid_mfa_code', async () => {
  const res = await request('POST', '/api/auth/mfa/confirm', { body: { code: '000000' } });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'invalid_mfa_code');
});

test('confirm with correct code -> enabled true', async () => {
  const code = computeTotp(superSecret, { time: Date.now(), digits: 6 });
  const res = await request('POST', '/api/auth/mfa/confirm', { body: { code } });
  assert.equal(res.status, 200);
  assert.equal(res.json.enabled, true);
});

test('enroll again after enabled -> 409', async () => {
  const res = await request('POST', '/api/auth/mfa/enroll');
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'mfa_already_enabled');
});

test('logout then login without mfa_code -> 403 mfa_required', async () => {
  await request('POST', '/api/auth/logout');
  cookieJar = null;
  const pw = process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!';
  const res = await request('POST', '/api/auth/login', { body: { identifier: 'superadmin@vra.local', password: pw } });
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'mfa_required');
});

test('login with wrong mfa_code -> 401', async () => {
  cookieJar = null;
  const pw = process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!';
  const res = await request('POST', '/api/auth/login', {
    body: { identifier: 'superadmin@vra.local', password: pw, mfa_code: '000000' }
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'invalid_mfa_code');
});

test('login with correct mfa_code -> 200', async () => {
  cookieJar = null;
  const pw = process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!';
  const code = computeTotp(superSecret, { time: Date.now(), digits: 6 });
  const res = await request('POST', '/api/auth/login', {
    body: { identifier: 'superadmin@vra.local', password: pw, mfa_code: code }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.mfa_enabled, true);
});

test('/me shows mfa_enabled true', async () => {
  const res = await request('GET', '/api/auth/me');
  assert.equal(res.status, 200);
  assert.equal(res.json.user.mfa_enabled, 1);
});

test('disable MFA with wrong password -> 401', async () => {
  const res = await request('POST', '/api/auth/mfa/disable', { body: { password: 'WrongPass123' } });
  assert.equal(res.status, 401);
});

test('disable MFA with correct password -> 200', async () => {
  const pw = process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!';
  const res = await request('POST', '/api/auth/mfa/disable', { body: { password: pw } });
  assert.equal(res.status, 200);
  assert.equal(res.json.enabled, false);
});

test('login after disable works without mfa_code', async () => {
  await request('POST', '/api/auth/logout');
  cookieJar = null;
  const pw = process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!';
  const res = await request('POST', '/api/auth/login', { body: { identifier: 'superadmin@vra.local', password: pw } });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.mfa_enabled, false);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
});