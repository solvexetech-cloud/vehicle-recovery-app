const crypto = require('node:crypto');

function hashBody(body) {
  const normalized = JSON.stringify(body || {});
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function findKey(db, scope, key) {
  if (!key) return null;
  return db.prepare('SELECT * FROM idempotency_keys WHERE scope = ? AND key = ?').get(scope, key);
}

function storeKey(db, scope, key, bodyHash, responseJson, status = 'completed') {
  db.prepare(
    'INSERT OR REPLACE INTO idempotency_keys (scope, key, status, response_json) VALUES (?, ?, ?, ?)'
  ).run(scope, key, status, JSON.stringify({ bodyHash, response: responseJson }));
}

function getStoredResponse(row) {
  try {
    const parsed = JSON.parse(row.response_json || '{}');
    return { bodyHash: parsed.bodyHash || null, response: parsed.response || null };
  } catch (_) {
    return { bodyHash: null, response: null };
  }
}

module.exports = { hashBody, findKey, storeKey, getStoredResponse };