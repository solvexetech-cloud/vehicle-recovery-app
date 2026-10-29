const crypto = require('node:crypto');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

function hashPassword(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, hash) => {
      if (err) return reject(err);
      resolve(`scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`);
    });
  });
}

function hashPasswordSync(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  return new Promise((resolve) => {
    try {
      const parts = String(stored).split('$');
      if (parts[0] !== 'scrypt') return resolve(false);
      const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
      const salt = Buffer.from(parts[4], 'base64');
      const expected = Buffer.from(parts[5], 'base64');
      crypto.scrypt(pw, salt, expected.length, { N, r, p }, (err, actual) => {
        if (err) return resolve(false);
        try { resolve(crypto.timingSafeEqual(expected, actual)); } catch { resolve(false); }
      });
    } catch { resolve(false); }
  });
}

const WEAK_PATTERNS = [/^password/i, /^12345/, /^qwerty/i, /^admin/i, /^letmein/i];

function isWeakPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return { weak: true, reason: 'min_length_8' };
  if (pw.length > 200) return { weak: true, reason: 'max_length_200' };
  if (!/[A-Za-z]/.test(pw)) return { weak: true, reason: 'needs_letter' };
  if (!/[0-9]/.test(pw)) return { weak: true, reason: 'needs_digit' };
  for (const re of WEAK_PATTERNS) if (re.test(pw)) return { weak: true, reason: 'too_common' };
  return { weak: false };
}

const ROLE_SESSION_SECONDS = {
  customer: 7 * 24 * 3600,
  driver: 7 * 24 * 3600,
  agency: 7 * 24 * 3600,
  country_admin: 12 * 3600,
  super_admin: 4 * 3600
};

function newSessionId() { return crypto.randomBytes(32).toString('base64url'); }

function createSession(db, userId, role, { ip, userAgent } = {}) {
  const sid = newSessionId();
  const seconds = ROLE_SESSION_SECONDS[role] || 24 * 3600;
  const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?,?,?,?,?)')
    .run(sid, userId, expiresAt, ip || null, userAgent || null);
  return { sid, expiresAt, maxAgeSec: seconds };
}

function getActiveSession(db, sid) {
  if (!sid) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  if (!s) return null;
  if (s.revoked_at) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  return s;
}

function revokeSession(db, sid) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), sid);
}

function revokeAllUserSessions(db, userId, exceptSid = null) {
  const now = new Date().toISOString();
  if (exceptSid) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL')
      .run(now, userId, exceptSid);
  } else {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(now, userId);
  }
}

function listUserSessions(db, userId) {
  return db.prepare(
    "SELECT id, created_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC"
  ).all(userId, new Date().toISOString());
}

const COOKIE_NAME = 'vra_sess';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function buildSessionCookie(sid, maxAgeSec, isProd) {
  const parts = [`${COOKIE_NAME}=${encodeURIComponent(sid)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (isProd) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function generateToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashToken(t) { return crypto.createHash('sha256').update(t).digest('hex'); }

function createEmailVerifyToken(db, userId, ttlHours = 24, opts = {}) {
  const invalidateOld = opts.invalidateOld !== false;
  if (invalidateOld) {
    db.prepare("UPDATE email_verification_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL")
      .run(new Date().toISOString(), userId);
  }
  const token = generateToken();
  const hash = hashToken(token);
  const expires = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES (?,?,?)')
    .run(userId, hash, expires);
  return token;
}

function consumeEmailVerifyToken(db, token) {
  const hash = hashToken(token);
  const row = db.prepare('SELECT * FROM email_verification_tokens WHERE token_hash = ? AND used_at IS NULL').get(hash);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  db.prepare('UPDATE email_verification_tokens SET used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  return row.user_id;
}

function createPasswordResetToken(db, userId, ttlHours = 1, opts = {}) {
  const invalidateOld = opts.invalidateOld !== false;
  if (invalidateOld) {
    db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL")
      .run(new Date().toISOString(), userId);
  }
  const token = generateToken();
  const hash = hashToken(token);
  const expires = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?,?,?)')
    .run(userId, hash, expires);
  return token;
}

function consumePasswordResetToken(db, token) {
  const hash = hashToken(token);
  const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL').get(hash);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  return row.user_id;
}

module.exports = {
  hashPassword, hashPasswordSync, verifyPassword, isWeakPassword,
  createSession, getActiveSession, revokeSession, revokeAllUserSessions, listUserSessions,
  parseCookies, buildSessionCookie, clearSessionCookie, COOKIE_NAME,
  createEmailVerifyToken, consumeEmailVerifyToken,
  createPasswordResetToken, consumePasswordResetToken,
  ROLE_SESSION_SECONDS
};