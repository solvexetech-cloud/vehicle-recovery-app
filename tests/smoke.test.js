process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-smoke-'));
process.env.DB_PATH = path.join(tmpDir, 'smoke.db');

const { createApp } = require('../src/app');

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
  });
}

test('GET /health returns 200, database ok, countries 6', async () => {
  const { app } = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await request(port, '/health');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.database, 'ok');
    assert.equal(body.countries, 6);
    assert.ok(body.version);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('GET / returns plain text', async () => {
  const { app } = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await request(port, '/');
    assert.equal(res.status, 200);
    assert.match(res.body, /Vehicle Recovery App/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('GET /nope returns 404 not_found JSON', async () => {
  const { app } = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await request(port, '/nope');
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.body).error, 'not_found');
  } finally {
    await new Promise((r) => server.close(r));
  }
});