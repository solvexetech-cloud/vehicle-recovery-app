process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Errors } = require('../src/errors');
const { errorHandler, notFoundHandler } = require('../src/middleware/error');

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

test('notFoundHandler returns 404', async () => {
  const app = express();
  app.use(notFoundHandler);
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

test('AppError maps to correct status + details', async () => {
  const app = express();
  app.get('/boom', (req, res, next) => next(Errors.validation('bad', { field: 'email' })));
  app.use(errorHandler);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await request(port, '/boom');
    assert.equal(res.status, 422);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'validation_error');
    assert.deepEqual(body.details, { field: 'email' });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('unknown error becomes 500 internal_error', async () => {
  const app = express();
  app.get('/bang', (req, res, next) => next(new Error('kaboom')));
  app.use(errorHandler);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await request(port, '/bang');
    assert.equal(res.status, 500);
    assert.equal(JSON.parse(res.body).error, 'internal_error');
  } finally {
    await new Promise((r) => server.close(r));
  }
});