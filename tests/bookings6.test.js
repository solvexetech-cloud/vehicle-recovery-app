process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-bookings6-'));
process.env.DB_PATH = path.join(tmp, 'bookings6.db');
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

async function newVerifiedCustomer(email, password) {
  cookieJar = null;
  const reg = await request('POST', '/api/auth/register', {
    body: { role: 'customer', full_name: 'C ' + email, email, password, country_code: 'QA' }
  });
  assert.equal(reg.status, 201, 'register failed: ' + reg.body);
  const ver = await request('GET', '/api/auth/verify-email?token=' + encodeURIComponent(reg.json.dev_verify_token));
  assert.equal(ver.status, 200);
  const login = await request('POST', '/api/auth/login', { body: { identifier: email, password } });
  assert.equal(login.status, 200);
  return login.json.user;
}

test('setup: server + configure QA towing pricing', async () => {
  const ctx = createApp();
  server = ctx.app.listen(0);
  db = ctx.db;
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;

  // Configure towing pricing for QA (id 1)
  db.prepare(
    "UPDATE country_services SET is_enabled = 1, base_fare_minor = 5000, per_km_minor = 300, fast_surcharge_minor = 1000, min_fare_minor = 8000 " +
    "WHERE country_id = 1 AND service_code = 'towing'"
  ).run();
  db.prepare("UPDATE country_services SET is_enabled = 0 WHERE country_id = 1 AND service_code != 'towing'").run();
  // Ensure tax is 5% (500bp) and cancellation defaults
  db.prepare("UPDATE country_settings SET tax_rate_bp = 500, cancellation_fee_minor = 2500, free_cancel_seconds = 300 WHERE country_id = 1").run();
});

test('anonymous /api/customer/bookings/estimate -> 401', async () => {
  cookieJar = null;
  const res = await request('POST', '/api/customer/bookings/estimate', { body: {} });
  assert.equal(res.status, 401);
});

test('estimate returns fare breakdown (towing 25.3/51.5 -> 25.3/51.55)', async () => {
  await newVerifiedCustomer('fare.cust@example.com', 'CustPass1234');
  const res = await request('POST', '/api/customer/bookings/estimate', { body: {
    service_type: 'towing',
    service_level: 'normal',
    pickup: { lat: 25.3, lng: 51.5 },
    destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-X1' }
  }});
  assert.equal(res.status, 200);
  assert.equal(res.json.currency_code, 'QAR');
  const fb = res.json.fare_breakdown;
  assert.equal(fb.base_fare_minor, 5000);
  assert.ok(fb.distance_km > 4.5 && fb.distance_km < 5.5);
  assert.ok(fb.distance_fare_minor > 1300 && fb.distance_fare_minor < 1700);
  assert.equal(fb.fast_surcharge_minor, 0);
  assert.equal(fb.tax_rate_bp, 500);
  assert.equal(res.json.cancellation_policy.fee_minor, 2500);
  assert.equal(res.json.cancellation_policy.free_cancel_seconds, 300);
});

test('estimate enforces min fare for short trip', async () => {
  const res = await request('POST', '/api/customer/bookings/estimate', { body: {
    service_type: 'towing',
    service_level: 'normal',
    pickup: { lat: 25.3, lng: 51.5 },
    destination: { lat: 25.3, lng: 51.5005 },
    vehicle: { category: 'suv', registration_number: 'QA-X1' }
  }});
  assert.equal(res.status, 200);
  assert.equal(res.json.fare_breakdown.subtotal_minor, 8000);
  assert.equal(res.json.fare_breakdown.tax_minor, 400);
  assert.equal(res.json.fare_breakdown.total_minor, 8400);
});

test('estimate with fast service adds surcharge', async () => {
  const res = await request('POST', '/api/customer/bookings/estimate', { body: {
    service_type: 'towing',
    service_level: 'fast',
    pickup: { lat: 25.3, lng: 51.5 },
    destination: { lat: 25.3, lng: 51.5005 },
    vehicle: { category: 'suv', registration_number: 'QA-X1' }
  }});
  assert.equal(res.status, 200);
  assert.equal(res.json.fare_breakdown.fast_surcharge_minor, 1000);
});

test('estimate for disabled service -> 422', async () => {
  const res = await request('POST', '/api/customer/bookings/estimate', { body: {
    service_type: 'winching',
    service_level: 'normal',
    pickup: { lat: 25.3, lng: 51.5 },
    destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-X1' }
  }});
  assert.equal(res.status, 422);
});

test('estimate with scheduled_at field -> 422 (Immediate only)', async () => {
  const res = await request('POST', '/api/customer/bookings/estimate', { body: {
    service_type: 'towing',
    pickup: { lat: 25.3, lng: 51.5 },
    destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-X1' },
    scheduled_at: '2030-01-01T10:00:00Z'
  }});
  assert.equal(res.status, 422);
  assert.equal(res.json.error, 'validation_error');
  assert.equal(res.json.message, 'scheduled_booking_not_supported');
});

test('estimate with invalid pickup -> 422', async () => {
  const res = await request('POST', '/api/customer/bookings/estimate', { body: {
    service_type: 'towing',
    pickup: { lat: 999, lng: 51.5 },
    destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-X1' }
  }});
  assert.equal(res.status, 422);
});

test('create booking without agreed_fare_minor -> 422', async () => {
  const est = await request('POST', '/api/customer/bookings/estimate', { body: {
    service_type: 'towing',
    pickup: { lat: 25.3, lng: 51.5 },
    destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-CREATE' }
  }});
  const res = await request('POST', '/api/customer/bookings', { body: {
    service_type: 'towing',
    pickup: { lat: 25.3, lng: 51.5 },
    destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-CREATE' }
  }});
  assert.equal(res.status, 422);
});

test('create booking with mismatched agreed_fare -> 422', async () => {
  const est = await request('POST', '/api/customer/bookings/estimate', { body: {
    service_type: 'towing',
    pickup: { lat: 25.3, lng: 51.5 },
    destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-CREATE' }
  }});
  const correctTotal = est.json.fare_breakdown.total_minor;
  const res = await request('POST', '/api/customer/bookings', { body: {
    service_type: 'towing',
    pickup: { lat: 25.3, lng: 51.5 },
    destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-CREATE' },
    agreed_fare_minor: correctTotal + 1
  }});
  assert.equal(res.status, 422);
});

test('create booking succeeds and returns booking_number', async () => {
  const est = await request('POST', '/api/customer/bookings/estimate', { body: {
    service_type: 'towing',
    service_level: 'normal',
    pickup: { lat: 25.3, lng: 51.5, address: 'Pickup Point A' },
    destination: { lat: 25.3, lng: 51.55, address: 'Garage B' },
    vehicle: { category: 'suv', registration_number: 'QA-NEW', make: 'Toyota' }
  }});
  const total = est.json.fare_breakdown.total_minor;
  const res = await request('POST', '/api/customer/bookings', { body: {
    service_type: 'towing',
    service_level: 'normal',
    pickup: { lat: 25.3, lng: 51.5, address: 'Pickup Point A' },
    destination: { lat: 25.3, lng: 51.55, address: 'Garage B' },
    vehicle: { category: 'suv', registration_number: 'QA-NEW', make: 'Toyota' },
    agreed_fare_minor: total
  }});
  assert.equal(res.status, 201);
  assert.match(res.json.booking.booking_number, /^BK-\d{8}-[A-F0-9]{8}$/);
  assert.equal(res.json.booking.status, 'created');
  assert.equal(res.json.booking.agreed_fare_minor, total);
  global.__firstBooking = res.json.booking;
});

test('booking appears in own list + status history has created', async () => {
  const list = await request('GET', '/api/customer/bookings');
  assert.equal(list.status, 200);
  assert.ok(list.json.bookings.length >= 1);

  const one = await request('GET', '/api/customer/bookings/' + global.__firstBooking.id);
  assert.equal(one.status, 200);
  assert.equal(one.json.booking.booking_number, global.__firstBooking.booking_number);
  assert.equal(one.json.history.length, 1);
  assert.equal(one.json.history[0].to_status, 'created');
});

test('idempotency: same key + same body returns same booking', async () => {
  const est = await request('POST', '/api/customer/bookings/estimate', { body: {
    service_type: 'towing',
    pickup: { lat: 25.3, lng: 51.5 },
    destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-IDEM' }
  }});
  const total = est.json.fare_breakdown.total_minor;
  const body = {
    service_type: 'towing',
    pickup: { lat: 25.3, lng: 51.5 },
    destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-IDEM' },
    agreed_fare_minor: total
  };
  const headers = { 'Idempotency-Key': 'test-idem-1' };
  const a = await request('POST', '/api/customer/bookings', { body, headers });
  const b = await request('POST', '/api/customer/bookings', { body, headers });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(a.json.booking.booking_number, b.json.booking.booking_number);
});

test('idempotency: same key + different body -> 409', async () => {
  const est = await request('POST', '/api/customer/bookings/estimate', { body: {
    service_type: 'towing',
    pickup: { lat: 25.3, lng: 51.5 },
    destination: { lat: 25.3, lng: 51.55 },
    vehicle: { category: 'suv', registration_number: 'QA-IDEM2' }
  }});
  const total = est.json.fare_breakdown.total_minor;
  const headers = { 'Idempotency-Key': 'test-idem-1' };
  const bodyDifferent = {
    service_type: 'towing',
    pickup: { lat: 25.3, lng: 51.5 },
    destination: { lat: 25.3, lng: 51.56 },
    vehicle: { category: 'suv', registration_number: 'QA-IDEM3' },
    agreed_fare_minor: total
  };
  const res = await request('POST', '/api/customer/bookings', { body: bodyDifferent, headers });
  assert.equal(res.status, 409);
});

test('isolation: customerB cannot read customerA booking (404)', async () => {
  const firstBookingId = global.__firstBooking.id;
  await newVerifiedCustomer('other.cust@example.com', 'CustPass1234');
  const res = await request('GET', '/api/customer/bookings/' + firstBookingId);
  assert.equal(res.status, 404);
});

test('customerB list is empty (has no bookings)', async () => {
  const res = await request('GET', '/api/customer/bookings');
  assert.equal(res.status, 200);
  assert.equal(res.json.bookings.length, 0);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
});