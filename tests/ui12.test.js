process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-ui12-'));
process.env.DB_PATH = path.join(tmp, 'ui12.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');

const { createApp } = require('../src/app');

let server, port;

function request(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    }).on('error', reject);
  });
}

test('setup', async () => {
  const ctx = createApp();
  server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
});

test('GET / serves index.html', async () => {
  const res = await request('/');
  assert.equal(res.status, 200);
  assert.match(res.body, /Vehicle Recovery/);
  assert.match(res.body, /<html/i);
});

test('GET /style.css serves CSS', async () => {
  const res = await request('/style.css');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'] || '', /text\/css/);
  assert.match(res.body, /--primary/);
});

test('GET /app.js serves JavaScript', async () => {
  const res = await request('/app.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'] || '', /javascript/);
  assert.match(res.body, /initLanding/);
});

test('GET /customer.html serves customer page', async () => {
  const res = await request('/customer.html');
  assert.equal(res.status, 200);
  assert.match(res.body, /Customer Dashboard/);
});

test('GET /driver.html serves driver page', async () => {
  const res = await request('/driver.html');
  assert.equal(res.status, 200);
  assert.match(res.body, /Driver Dashboard/);
});

test('GET /admin.html serves admin page', async () => {
  const res = await request('/admin.html');
  assert.equal(res.status, 200);
  assert.match(res.body, /Admin Dashboard/);
});

test('GET /health still works', async () => {
  const res = await request('/health');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'ok');
  assert.equal(body.version, '1.0.0');
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
});