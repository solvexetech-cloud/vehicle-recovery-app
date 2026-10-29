process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-auth32-'));
process.env.DB_PATH = path.join(tmp, 'auth32.db');

const { createApp } = require('../src/app');

let server, port, db;
let cookieJar = null;

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

async function newVerifiedCustomer(email, password = 'GoodPass123!') {
  cookieJar = null;
  const reg = await request('POST', '/api/auth/register', {
    body: { role: 'customer', full_name: 'Customer', email, password, country_code: 'QA' }
  });
  assert.equal(reg.status, 201);
  const token = reg.json.dev_verify_token;
  const ver = await request('GET', '/api/auth/verify-email?token=' + encodeURIComponent(token));
  assert.equal(ver.status, 200);
  const login = await request('POST', '/api/auth/login', { body: { identifier: email, password } });
  assert.equal(login.status, 200);
  return login.json.user;
}

test('setup', async () => {
  const ctx = createApp();
  server = ctx.app.listen(0);
  db = ctx.db;
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
});

test('health still ok', async () => {
  const res = await request('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.database, 'ok');
});

test('resend-verification returns new token and invalidates old', async () => {
  cookieJar = null;
  const reg = await request('POST', '/api/auth/register', {
    body: { role: 'customer', full_name: 'Pending', email: 'pending@example.com', password: 'PassTest123', country_code: 'QA' }
  });
  assert.equal(reg.status, 201);
  const t1 = reg.json.dev_verify_token;

  const re = await request('POST', '/api/auth/resend-verification', { body: { email: 'pending@example.com' } });
  assert.equal(re.status, 200);
  const t2 = re.json.dev_verify_token;
  assert.notEqual(t1, t2);

  const bad = await request('GET', '/api/auth/verify-email?token=' + encodeURIComponent(t1));
  assert.equal(bad.status, 422);

  const good = await request('GET', '/api/auth/verify-email?token=' + encodeURIComponent(t2));
  assert.equal(good.status, 200);
});

test('resend-verification rate-limited within 60s', async () => {
  const res = await request('POST', '/api/auth/resend-verification', { body: { email: 'pending@example.com' } });
  assert.equal(res.status, 409);
});

test('resend-verification unknown email still returns ok', async () => {
  const res = await request('POST', '/api/auth/resend-verification', { body: { email: 'nobody@example.com' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
});

test('forgot-password returns dev token for active user', async () => {
  await newVerifiedCustomer('forget@example.com', 'OriginalPass123');
  const res = await request('POST', '/api/auth/forgot-password', { body: { email: 'forget@example.com' } });
  assert.equal(res.status, 200);
  assert.ok(res.json.dev_reset_token);
});

test('forgot-password unknown email returns ok but no dev token', async () => {
  const res = await request('POST', '/api/auth/forgot-password', { body: { email: 'ghost@example.com' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.dev_reset_token, undefined);
});

test('reset-password revokes all user sessions', async () => {
  await newVerifiedCustomer('reset@example.com', 'OriginalPass123');
  const origCookie = cookieHeader();

  const forgot = await request('POST', '/api/auth/forgot-password', { body: { email: 'reset@example.com' } });
  const resetToken = forgot.json.dev_reset_token;
  assert.ok(resetToken);

  const reset = await request('POST', '/api/auth/reset-password', {
    body: { token: resetToken, new_password: 'BrandNewPass456!' }
  });
  assert.equal(reset.status, 200);

  // old session dead
  const me = await request('GET', '/api/auth/me', { headers: { Cookie: origCookie } });
  assert.equal(me.status, 401);

  // new password works
  cookieJar = null;
  const login = await request('POST', '/api/auth/login', {
    body: { identifier: 'reset@example.com', password: 'BrandNewPass456!' }
  });
  assert.equal(login.status, 200);
});

test('reset-password rejects weak new password', async () => {
  await newVerifiedCustomer('resetweak@example.com', 'OriginalPass123');
  const forgot = await request('POST', '/api/auth/forgot-password', { body: { email: 'resetweak@example.com' } });
  const resetToken = forgot.json.dev_reset_token;
  const res = await request('POST', '/api/auth/reset-password', {
    body: { token: resetToken, new_password: 'short' }
  });
  assert.equal(res.status, 422);
});

test('reset-password rejects used token (single-use)', async () => {
  await newVerifiedCustomer('singleuse@example.com', 'OriginalPass123');
  const forgot = await request('POST', '/api/auth/forgot-password', { body: { email: 'singleuse@example.com' } });
  const token = forgot.json.dev_reset_token;
  if (!token) throw new Error('expected dev_reset_token for singleuse');
  const a = await request('POST', '/api/auth/reset-password', { body: { token, new_password: 'AnotherPass789!' } });
  assert.equal(a.status, 200);
  const b = await request('POST', '/api/auth/reset-password', { body: { token, new_password: 'AnotherPass789!' } });
  assert.equal(b.status, 422);
});

test('change-password rejects wrong current password', async () => {
  await newVerifiedCustomer('chpwbad@example.com', 'OriginalPass123');
  const res = await request('POST', '/api/auth/change-password', {
    headers: { Cookie: cookieHeader() },
    body: { current_password: 'WrongOldPass', new_password: 'NewPass456!' }
  });
  assert.equal(res.status, 401);
});

test('change-password succeeds, keeps current session, revokes others', async () => {
  await newVerifiedCustomer('chpw@example.com', 'OriginalPass123');
  const cookie1 = cookieHeader();

  const login2 = await request('POST', '/api/auth/login', {
    body: { identifier: 'chpw@example.com', password: 'OriginalPass123' }
  });
  assert.equal(login2.status, 200);
  const cookie2 = cookieHeader();

  const change = await request('POST', '/api/auth/change-password', {
    headers: { Cookie: cookie1 },
    body: { current_password: 'OriginalPass123', new_password: 'NewPass456!' }
  });
  assert.equal(change.status, 200);

  const me1 = await request('GET', '/api/auth/me', { headers: { Cookie: cookie1 } });
  assert.equal(me1.status, 200);

  const me2 = await request('GET', '/api/auth/me', { headers: { Cookie: cookie2 } });
  assert.equal(me2.status, 401);
});

test('list sessions shows 3 for triple-login user', async () => {
  await newVerifiedCustomer('sess@example.com', 'OriginalPass123');
  const c1 = cookieHeader();
  await request('POST', '/api/auth/login', { body: { identifier: 'sess@example.com', password: 'OriginalPass123' } });
  const c2 = cookieHeader();
  await request('POST', '/api/auth/login', { body: { identifier: 'sess@example.com', password: 'OriginalPass123' } });
  const c3 = cookieHeader();

  const list = await request('GET', '/api/auth/sessions', { headers: { Cookie: c2 } });
  assert.equal(list.status, 200);
  assert.equal(list.json.sessions.length, 3);
  assert.ok(list.json.current_session_id);

  const others = list.json.sessions.filter((s) => s.id !== list.json.current_session_id);
  assert.equal(others.length, 2);
});

test('delete one session leaves others working', async () => {
  await newVerifiedCustomer('sessdel@example.com', 'OriginalPass123');
  const c1 = cookieHeader();
  await request('POST', '/api/auth/login', { body: { identifier: 'sessdel@example.com', password: 'OriginalPass123' } });
  const c2 = cookieHeader();

  const list = await request('GET', '/api/auth/sessions', { headers: { Cookie: c2 } });
  const others = list.json.sessions.filter((s) => s.id !== list.json.current_session_id);
  assert.ok(others.length >= 1);

  const del = await request('DELETE', '/api/auth/sessions/' + others[0].id, { headers: { Cookie: c2 } });
  assert.equal(del.status, 200);

  const list2 = await request('GET', '/api/auth/sessions', { headers: { Cookie: c2 } });
  assert.equal(list2.json.sessions.length, 1);
});

test('cannot revoke another user session (404)', async () => {
  await newVerifiedCustomer('uA@example.com', 'OriginalPass123');
  const cookieA = cookieHeader();

  await newVerifiedCustomer('uB@example.com', 'OriginalPass123');
  const cookieB = cookieHeader();

  const listB = await request('GET', '/api/auth/sessions', { headers: { Cookie: cookieB } });
  const sessB = listB.json.sessions[0];

  const del = await request('DELETE', '/api/auth/sessions/' + sessB.id, { headers: { Cookie: cookieA } });
  assert.equal(del.status, 404);

  const meB = await request('GET', '/api/auth/me', { headers: { Cookie: cookieB } });
  assert.equal(meB.status, 200);
});

test('revoking nonexistent session returns 404', async () => {
  const res = await request('DELETE', '/api/auth/sessions/does-not-exist', { headers: { Cookie: cookieHeader() } });
  assert.equal(res.status, 404);
});

test('sessions endpoints require auth', async () => {
  cookieJar = null;
  const l = await request('GET', '/api/auth/sessions');
  assert.equal(l.status, 401);
  const r = await request('DELETE', '/api/auth/sessions/whatever');
  assert.equal(r.status, 401);
});

test('super_admin force-logout kills target sessions', async () => {
  await newVerifiedCustomer('target@example.com', 'OriginalPass123');
  const targetCookie = cookieHeader();

  cookieJar = null;
  const adminLogin = await request('POST', '/api/auth/login', {
    body: { identifier: 'superadmin@vra.local', password: process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!' }
  });
  assert.equal(adminLogin.status, 200);
  const adminCookie = cookieHeader();

  const target = db.prepare("SELECT id FROM users WHERE email = 'target@example.com'").get();
  const fo = await request('POST', '/api/admin/users/' + target.id + '/force-logout', {
    headers: { Cookie: adminCookie }
  });
  assert.equal(fo.status, 200);
  assert.ok(fo.json.revoked >= 1);

  const me = await request('GET', '/api/auth/me', { headers: { Cookie: targetCookie } });
  assert.equal(me.status, 401);
});

test('customer cannot use force-logout', async () => {
  await newVerifiedCustomer('nope@example.com', 'OriginalPass123');
  const res = await request('POST', '/api/admin/users/1/force-logout', {
    headers: { Cookie: cookieHeader() }
  });
  assert.equal(res.status, 403);
});

test('force-logout nonexistent user returns 404', async () => {
  cookieJar = null;
  await request('POST', '/api/auth/login', {
    body: { identifier: 'superadmin@vra.local', password: process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!' }
  });
  const res = await request('POST', '/api/admin/users/999999/force-logout', {
    headers: { Cookie: cookieHeader() }
  });
  assert.equal(res.status, 404);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
});