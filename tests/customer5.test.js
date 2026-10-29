process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-cust5-'));
process.env.DB_PATH = path.join(tmp, 'cust5.db');

const { createApp } = require('../src/app');

let server, port, cookieJar = null;

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

async function newVerifiedCustomer(email, password) {
  cookieJar = null;
  const reg = await request('POST', '/api/auth/register', {
    body: { role: 'customer', full_name: 'Cust ' + email, email, password, country_code: 'QA' }
  });
  if (reg.status === 201) {
    const ver = await request('GET', '/api/auth/verify-email?token=' + encodeURIComponent(reg.json.dev_verify_token));
    assert.equal(ver.status, 200);
  } else if (reg.status === 409) {
    // Already registered in an earlier test — just login
  } else {
    assert.fail('register failed: ' + reg.body);
  }
  const login = await request('POST', '/api/auth/login', { body: { identifier: email, password } });
  assert.equal(login.status, 200, 'login failed: ' + login.body);
  return login.json.user;
}

test('setup server', async () => {
  const ctx = createApp();
  server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
});

test('anonymous /api/customer/profile -> 401', async () => {
  cookieJar = null;
  const res = await request('GET', '/api/customer/profile');
  assert.equal(res.status, 401);
});

test('country_admin cannot access /api/customer/profile (403)', async () => {
  cookieJar = null;
  const pw = process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!';
  await request('POST', '/api/auth/login', { body: { identifier: 'superadmin@vra.local', password: pw } });
  const mk = await request('POST', '/api/super/country-admins', {
    body: { email: 'qa42admin@example.com', password: 'QaAdminPass123!', full_name: 'QA Admin', country_code: 'QA' }
  });
  assert.equal(mk.status, 201);
  cookieJar = null;
  await request('POST', '/api/auth/login', { body: { identifier: 'qa42admin@example.com', password: 'QaAdminPass123!' } });
  const res = await request('GET', '/api/customer/profile');
  assert.equal(res.status, 403);
});

test('customerA profile GET returns defaults + limits', async () => {
  await newVerifiedCustomer('a.cust@example.com', 'CustPass1234');
  const res = await request('GET', '/api/customer/profile');
  assert.equal(res.status, 200);
  assert.equal(res.json.profile.email, 'a.cust@example.com');
  assert.equal(res.json.country.code, 'QA');
  assert.equal(res.json.limits.max_saved_vehicles, 5);
  assert.equal(res.json.limits.max_saved_destinations, 10);
  assert.equal(res.json.vehicle_count, 0);
  assert.equal(res.json.destination_count, 0);
});

test('customerA PATCH profile full_name + phone', async () => {
  const res = await request('PATCH', '/api/customer/profile', {
    body: { full_name: 'Customer A', phone: '+97412345678' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.profile.full_name, 'Customer A');
  assert.equal(res.json.profile.phone, '+97412345678');
});

test('customerA PATCH empty body -> 422', async () => {
  const res = await request('PATCH', '/api/customer/profile', { body: {} });
  assert.equal(res.status, 422);
});

test('customerA PATCH invalid phone -> 422', async () => {
  const res = await request('PATCH', '/api/customer/profile', { body: { phone: 'xyz' } });
  assert.equal(res.status, 422);
});

test('customerA add first vehicle -> auto-default', async () => {
  const res = await request('POST', '/api/customer/vehicles', {
    body: { category: 'suv', make: 'Toyota', model: 'Land Cruiser', colour: 'White', registration_number: 'QA-111' }
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.vehicle.is_default, 1);
  assert.equal(res.json.vehicle.category, 'suv');
});

test('customerA add second vehicle -> not default', async () => {
  const res = await request('POST', '/api/customer/vehicles', {
    body: { category: 'sedan_hatchback', registration_number: 'QA-222' }
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.vehicle.is_default, 0);
});

test('customerA GET vehicles returns 2 (default first)', async () => {
  const res = await request('GET', '/api/customer/vehicles');
  assert.equal(res.status, 200);
  assert.equal(res.json.vehicles.length, 2);
  assert.equal(res.json.vehicles[0].registration_number, 'QA-111');
});

test('customerA set vehicle #2 default -> #1 not default', async () => {
  const list = await request('GET', '/api/customer/vehicles');
  const id2 = list.json.vehicles.find((v) => v.registration_number === 'QA-222').id;
  const res = await request('POST', '/api/customer/vehicles/' + id2 + '/default');
  assert.equal(res.status, 200);
  assert.equal(res.json.vehicle.is_default, 1);
  const list2 = await request('GET', '/api/customer/vehicles');
  const defaultCount = list2.json.vehicles.filter((v) => v.is_default === 1).length;
  assert.equal(defaultCount, 1);
});

test('customerA invalid category -> 422', async () => {
  const res = await request('POST', '/api/customer/vehicles', {
    body: { category: 'spaceship', registration_number: 'QA-333' }
  });
  assert.equal(res.status, 422);
});

test('customerA missing registration_number -> 422', async () => {
  const res = await request('POST', '/api/customer/vehicles', { body: { category: 'suv' } });
  assert.equal(res.status, 422);
});

test('customerA limit 5 vehicles -> 6th -> 409', async () => {
  const base = (await request('GET', '/api/customer/vehicles')).json.vehicles.length;
  for (let i = base; i < 5; i++) {
    const res = await request('POST', '/api/customer/vehicles', {
      body: { category: 'suv', registration_number: 'QA-EXTRA-' + i }
    });
    assert.equal(res.status, 201, 'setup add ' + i + ' failed: ' + res.body);
  }
  const over = await request('POST', '/api/customer/vehicles', {
    body: { category: 'suv', registration_number: 'QA-OVER' }
  });
  assert.equal(over.status, 409);
  assert.equal(over.json.error, 'conflict');
});

test('customerA PATCH vehicle colour', async () => {
  const list = (await request('GET', '/api/customer/vehicles')).json.vehicles;
  const res = await request('PATCH', '/api/customer/vehicles/' + list[0].id, { body: { colour: 'Black' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.vehicle.colour, 'Black');
});

test('customerA DELETE vehicle -> removed', async () => {
  const list = (await request('GET', '/api/customer/vehicles')).json.vehicles;
  const target = list.find((v) => v.is_default === 0);
  assert.ok(target);
  const res = await request('DELETE', '/api/customer/vehicles/' + target.id);
  assert.equal(res.status, 200);
  const after = (await request('GET', '/api/customer/vehicles')).json.vehicles;
  assert.equal(after.length, list.length - 1);
});

test('customerA add destination (valid)', async () => {
  const res = await request('POST', '/api/customer/destinations', {
    body: { label: 'Home workshop', address: 'Doha Industrial Area', lat: 25.2, lng: 51.5, contact_phone: '+97498765432' }
  });
  assert.equal(res.status, 201);
  assert.ok(res.json.destination.id);
});

test('customerA invalid lat -> 422', async () => {
  const res = await request('POST', '/api/customer/destinations', {
    body: { label: 'X', address: 'Y', lat: 999, lng: 51.5 }
  });
  assert.equal(res.status, 422);
});

test('customerA PATCH destination label', async () => {
  const list = (await request('GET', '/api/customer/destinations')).json.destinations;
  const res = await request('PATCH', '/api/customer/destinations/' + list[0].id, { body: { label: 'Main garage' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.destination.label, 'Main garage');
});

test('customerB (isolation) sees empty vehicles + destinations', async () => {
  await newVerifiedCustomer('b.cust@example.com', 'CustPass1234');
  const v = await request('GET', '/api/customer/vehicles');
  const d = await request('GET', '/api/customer/destinations');
  assert.equal(v.status, 200);
  assert.equal(v.json.vehicles.length, 0);
  assert.equal(d.json.destinations.length, 0);
});

test('customerB cannot PATCH customerA vehicle (404)', async () => {
  // Get customerA id via superadmin (simplest) — but simpler: use DB from app
  // Since we don't have db handle here, use direct SQL through existing customer A rows
  // We'll just try random ids that belong to A: A has some vehicles after earlier tests
  // Find one id from A's list by logging in as A, then login as B and try PATCH.
  await newVerifiedCustomer('a.cust@example.com', 'CustPass1234');
  const aList = (await request('GET', '/api/customer/vehicles')).json.vehicles;
  const aVehicleId = aList[0].id;

  await newVerifiedCustomer('b.cust@example.com', 'CustPass1234');
  const res = await request('PATCH', '/api/customer/vehicles/' + aVehicleId, { body: { colour: 'Hacked' } });
  assert.equal(res.status, 404);
});

test('customerB cannot DELETE customerA destination (404)', async () => {
  await newVerifiedCustomer('a.cust@example.com', 'CustPass1234');
  const aD = (await request('GET', '/api/customer/destinations')).json.destinations;
  const aDestId = aD[0].id;

  await newVerifiedCustomer('b.cust@example.com', 'CustPass1234');
  const res = await request('DELETE', '/api/customer/destinations/' + aDestId);
  assert.equal(res.status, 404);
});

test('destination limit 10 enforced', async () => {
  await newVerifiedCustomer('limit.cust@example.com', 'CustPass1234');
  for (let i = 0; i < 10; i++) {
    const res = await request('POST', '/api/customer/destinations', {
      body: { label: 'D' + i, address: 'Addr ' + i, lat: 25 + i * 0.001, lng: 51 + i * 0.001 }
    });
    assert.equal(res.status, 201, 'dest ' + i + ' failed');
  }
  const over = await request('POST', '/api/customer/destinations', {
    body: { label: 'D10', address: 'Over', lat: 25.1, lng: 51.1 }
  });
  assert.equal(over.status, 409);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
});