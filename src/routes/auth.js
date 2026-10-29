const express = require('express');
const { Errors } = require('../errors');
const {
  hashPassword, verifyPassword, isWeakPassword,
  createSession, revokeSession, revokeAllUserSessions, listUserSessions,
  buildSessionCookie, clearSessionCookie,
  createEmailVerifyToken, consumeEmailVerifyToken,
  createPasswordResetToken, consumePasswordResetToken
} = require('../auth');
const { generateSecret, computeTotp, verifyTotp, otpauthUrl } = require('../mfa/totp');
const { audit } = require('../audit');
const { requireAuth } = require('../middleware/auth');
const { logger } = require('../logger');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PUBLIC_ROLES = new Set(['customer', 'driver', 'agency']);

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 5;

function normalizeId(s) { return String(s || '').trim().toLowerCase(); }

function routes(db, config) {
  const r = express.Router();
  const isDev = config.nodeEnv !== 'production';
  const issuer = 'VehicleRecovery';

  const loginAttempts = new Map();
  const resendCooldown = new Map();
  const forgotCooldown = new Map();
  const COOLDOWN_MS = 60 * 1000;

  function checkRateLimit(id) {
    const now = Date.now();
    const e = loginAttempts.get(id);
    if (!e) return true;
    if (now - e.first > RATE_WINDOW_MS) { loginAttempts.delete(id); return true; }
    return e.count < RATE_MAX;
  }
  function recordAttempt(id) {
    const now = Date.now();
    const e = loginAttempts.get(id);
    if (!e || now - e.first > RATE_WINDOW_MS) loginAttempts.set(id, { first: now, count: 1 });
    else e.count += 1;
  }
  function clearAttempts(id) { loginAttempts.delete(id); }
  function checkCooldown(map, key) {
    const now = Date.now();
    const prev = map.get(key);
    if (prev && now - prev < COOLDOWN_MS) return false;
    map.set(key, now);
    return true;
  }

  // ---------- Registration ----------
  r.post('/register', async (req, res, next) => {
    try {
      const { role, full_name, email, phone, password, country_code } = req.body || {};
      if (!PUBLIC_ROLES.has(role)) return next(Errors.validation('invalid_role', { allowed: [...PUBLIC_ROLES] }));
      if (!full_name || full_name.trim().length < 2) return next(Errors.validation('invalid_full_name'));
      if (!email || !EMAIL_RE.test(email)) return next(Errors.validation('invalid_email'));
      const w = isWeakPassword(password);
      if (w.weak) return next(Errors.validation('weak_password', { reason: w.reason }));
      const country = db.prepare('SELECT * FROM countries WHERE code = ?').get(String(country_code || '').toUpperCase());
      if (!country) return next(Errors.validation('invalid_country'));
      if (!country.is_active) return next(Errors.validation('country_not_active'));

      const normEmail = normalizeId(email);
      if (db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail)) {
        return next(Errors.conflict('email_already_registered'));
      }

      const pwHash = await hashPassword(password);
      let userId;
      try {
        const tx = db.prepare(
          "INSERT INTO users (country_id, role, full_name, email, phone, password_hash, status) VALUES (?,?,?,?,?,?, 'pending')"
        ).run(country.id, role, full_name.trim(), normEmail, phone || null, pwHash);
        userId = Number(tx.lastInsertRowid);
      } catch (e) {
        if (/UNIQUE/i.test(e.message)) return next(Errors.conflict('email_already_registered'));
        throw e;
      }

      const token = createEmailVerifyToken(db, userId);
      audit(db, {
        actor_user_id: userId, actor_role: role, action: 'user.register',
        entity_type: 'user', entity_id: userId, country_id: country.id,
        ip: req.ip, user_agent: req.headers['user-agent']
      });

      const payload = { ok: true, user_id: userId, status: 'pending' };
      if (isDev) {
        payload.dev_verify_token = token;
        payload.dev_verify_url = '/api/auth/verify-email?token=' + token;
      }
      res.status(201).json(payload);
    } catch (e) { next(e); }
  });

  r.get('/verify-email', (req, res, next) => {
    try {
      const token = String(req.query.token || '');
      if (!token) return next(Errors.validation('missing_token'));
      const userId = consumeEmailVerifyToken(db, token);
      if (!userId) return next(Errors.validation('invalid_or_expired_token'));
      const now = new Date().toISOString();
      db.prepare("UPDATE users SET status = 'active', email_verified_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, userId);
      audit(db, {
        actor_user_id: userId, action: 'user.email_verified',
        entity_type: 'user', entity_id: userId,
        ip: req.ip, user_agent: req.headers['user-agent']
      });
      res.json({ ok: true, user_id: Number(userId) });
    } catch (e) { next(e); }
  });

  r.post('/resend-verification', (req, res, next) => {
    try {
      const { email } = req.body || {};
      if (!email) return next(Errors.validation('email_required'));
      const idNorm = normalizeId(email);
      if (!checkCooldown(resendCooldown, idNorm)) return next(Errors.conflict('resend_too_soon'));

      const user = db.prepare('SELECT id, status FROM users WHERE email = ?').get(idNorm);
      if (!user || user.status !== 'pending') return res.json({ ok: true });
      const token = createEmailVerifyToken(db, user.id);
      audit(db, { actor_user_id: user.id, action: 'user.resend_verification',
        entity_type: 'user', entity_id: user.id,
        ip: req.ip, user_agent: req.headers['user-agent'] });
      const payload = { ok: true };
      if (isDev) {
        payload.dev_verify_token = token;
        payload.dev_verify_url = '/api/auth/verify-email?token=' + token;
      }
      res.json(payload);
    } catch (e) { next(e); }
  });

  r.post('/forgot-password', (req, res, next) => {
    try {
      const { email } = req.body || {};
      if (!email) return next(Errors.validation('email_required'));
      const idNorm = normalizeId(email);
      if (!checkCooldown(forgotCooldown, idNorm)) return next(Errors.conflict('forgot_too_soon'));

      const user = db.prepare('SELECT id, status FROM users WHERE email = ?').get(idNorm);
      if (!user || user.status !== 'active') return res.json({ ok: true });
      const token = createPasswordResetToken(db, user.id, 1);
      audit(db, { actor_user_id: user.id, action: 'user.password_reset_requested',
        entity_type: 'user', entity_id: user.id,
        ip: req.ip, user_agent: req.headers['user-agent'] });
      const payload = { ok: true };
      if (isDev) {
        payload.dev_reset_token = token;
        payload.dev_reset_url = '/api/auth/reset-password?token=' + token;
        logger.info('auth.forgot.dev_reset', { userId: user.id, url: payload.dev_reset_url });
      }
      res.json(payload);
    } catch (e) { next(e); }
  });

  r.post('/reset-password', async (req, res, next) => {
    try {
      const { token, new_password } = req.body || {};
      if (!token || !new_password) return next(Errors.validation('token_and_new_password_required'));
      const w = isWeakPassword(new_password);
      if (w.weak) return next(Errors.validation('weak_password', { reason: w.reason }));
      const userId = consumePasswordResetToken(db, token);
      if (!userId) return next(Errors.validation('invalid_or_expired_token'));
      const pwHash = await hashPassword(new_password);
      const now = new Date().toISOString();
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(pwHash, now, userId);
      revokeAllUserSessions(db, userId);
      audit(db, { actor_user_id: Number(userId), action: 'user.password_reset',
        entity_type: 'user', entity_id: Number(userId),
        ip: req.ip, user_agent: req.headers['user-agent'] });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/change-password', requireAuth, async (req, res, next) => {
    try {
      const { current_password, new_password } = req.body || {};
      if (!current_password || !new_password) return next(Errors.validation('current_and_new_password_required'));
      if (current_password === new_password) return next(Errors.validation('new_password_must_differ'));
      const w = isWeakPassword(new_password);
      if (w.weak) return next(Errors.validation('weak_password', { reason: w.reason }));
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
      const ok = await verifyPassword(current_password, row.password_hash);
      if (!ok) return next(Errors.unauthorized('invalid_current_password'));
      const pwHash = await hashPassword(new_password);
      const now = new Date().toISOString();
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(pwHash, now, req.user.id);
      revokeAllUserSessions(db, req.user.id, req.session.id);
      audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'user.password_changed', entity_type: 'user', entity_id: req.user.id,
        ip: req.ip, user_agent: req.headers['user-agent'] });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.get('/sessions', requireAuth, (req, res) => {
    const sessions = listUserSessions(db, req.user.id);
    res.json({ sessions, current_session_id: req.session.id });
  });

  r.delete('/sessions/:id', requireAuth, (req, res, next) => {
    const sid = String(req.params.id || '');
    const s = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sid, req.user.id);
    if (!s) return next(Errors.notFound('session_not_found'));
    revokeSession(db, sid);
    audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
      action: 'auth.session_revoked', entity_type: 'session',
      metadata: { session_id: sid },
      ip: req.ip, user_agent: req.headers['user-agent'] });
    res.json({ ok: true });
  });

  // ---------- MFA ----------
  r.post('/mfa/enroll', requireAuth, (req, res, next) => {
    try {
      const row = db.prepare('SELECT mfa_enabled, mfa_secret, email FROM users WHERE id = ?').get(req.user.id);
      if (row.mfa_enabled) return next(Errors.mfaAlreadyEnabled());

      const secret = generateSecret();
      db.prepare('UPDATE users SET mfa_secret = ?, mfa_enabled = 0, updated_at = ? WHERE id = ?')
        .run(secret, new Date().toISOString(), req.user.id);

      const url = otpauthUrl({ secret, issuer, accountName: row.email });
      audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'auth.mfa_enrollment_started', entity_type: 'user', entity_id: req.user.id,
        ip: req.ip, user_agent: req.headers['user-agent'] });

      res.json({
        enabled: false,
        secret,
        otpauth_url: url,
        hint: 'Scan otpauth_url with any TOTP app, then POST /api/auth/mfa/confirm with { code }.'
      });
    } catch (e) { next(e); }
  });

  r.post('/mfa/confirm', requireAuth, (req, res, next) => {
    try {
      const code = String((req.body || {}).code || '').trim();
      if (!code) return next(Errors.validation('code_required'));

      const row = db.prepare('SELECT mfa_enabled, mfa_secret FROM users WHERE id = ?').get(req.user.id);
      if (row.mfa_enabled) return next(Errors.mfaAlreadyEnabled());
      if (!row.mfa_secret) return next(Errors.mfaNotInitiated());

      if (!verifyTotp(row.mfa_secret, code, { window: 1 })) {
        audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
          action: 'auth.mfa_confirm_failed', entity_type: 'user', entity_id: req.user.id,
          ip: req.ip, user_agent: req.headers['user-agent'] });
        return next(Errors.invalidMfaCode());
      }

      db.prepare('UPDATE users SET mfa_enabled = 1, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), req.user.id);
      audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'auth.mfa_enabled', entity_type: 'user', entity_id: req.user.id,
        ip: req.ip, user_agent: req.headers['user-agent'] });
      res.json({ enabled: true });
    } catch (e) { next(e); }
  });

  r.post('/mfa/disable', requireAuth, async (req, res, next) => {
    try {
      const password = String((req.body || {}).password || '');
      if (!password) return next(Errors.validation('password_required'));

      const row = db.prepare('SELECT password_hash, mfa_enabled FROM users WHERE id = ?').get(req.user.id);
      if (!row.mfa_enabled) return next(Errors.validation('mfa_not_enabled'));

      const ok = await verifyPassword(password, row.password_hash);
      if (!ok) return next(Errors.unauthorized('invalid_password'));

      db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), req.user.id);
      revokeAllUserSessions(db, req.user.id, req.session.id);
      audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'auth.mfa_disabled', entity_type: 'user', entity_id: req.user.id,
        ip: req.ip, user_agent: req.headers['user-agent'] });
      res.json({ enabled: false });
    } catch (e) { next(e); }
  });

  // ---------- Login ----------
  r.post('/login', async (req, res, next) => {
    try {
      const { identifier, password } = req.body || {};
      if (!identifier || !password) return next(Errors.validation('identifier_and_password_required'));
      const idNorm = normalizeId(identifier);
      if (!checkRateLimit(idNorm)) return next(Errors.conflict('rate_limited'));
      recordAttempt(idNorm);

      const user = db.prepare(
        'SELECT id, country_id, role, full_name, email, phone, password_hash, status, mfa_enabled, mfa_secret FROM users WHERE email = ? OR phone = ?'
      ).get(idNorm, identifier);

      if (!user) {
        audit(db, { action: 'auth.login_failed', entity_type: 'user',
          metadata: { identifier: idNorm, reason: 'unknown' },
          ip: req.ip, user_agent: req.headers['user-agent'] });
        return next(Errors.unauthorized('invalid_credentials'));
      }

      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) {
        audit(db, { actor_user_id: user.id, actor_role: user.role, action: 'auth.login_failed',
          entity_type: 'user', entity_id: user.id, metadata: { reason: 'bad_password' },
          ip: req.ip, user_agent: req.headers['user-agent'] });
        return next(Errors.unauthorized('invalid_credentials'));
      }
      if (user.status === 'pending') return next(Errors.forbidden('email_not_verified'));
      if (user.status !== 'active') return next(Errors.forbidden('account_' + user.status));

      // Super admin MFA policy (optional, off by default)
      if (user.role === 'super_admin' && config.mfaRequiredForSuperAdmin && !user.mfa_enabled) {
        audit(db, { actor_user_id: user.id, actor_role: user.role,
          action: 'auth.login_blocked_mfa_setup_required', entity_type: 'user', entity_id: user.id,
          ip: req.ip, user_agent: req.headers['user-agent'] });
        return next(Errors.mfaSetupRequired());
      }

      // MFA verification (if enabled)
      if (user.mfa_enabled) {
        const mfaCode = String((req.body || {}).mfa_code || '').trim();
        if (!mfaCode) {
          // Not counted as a failed attempt (password is correct; user just needs to send code)
          return next(Errors.mfaRequired());
        }
        if (!verifyTotp(user.mfa_secret, mfaCode, { window: 1 })) {
          audit(db, { actor_user_id: user.id, actor_role: user.role,
            action: 'auth.mfa_verification_failed', entity_type: 'user', entity_id: user.id,
            ip: req.ip, user_agent: req.headers['user-agent'] });
          return next(Errors.invalidMfaCode());
        }
        audit(db, { actor_user_id: user.id, actor_role: user.role,
          action: 'auth.mfa_verification_success', entity_type: 'user', entity_id: user.id,
          ip: req.ip, user_agent: req.headers['user-agent'] });
      }

      clearAttempts(idNorm);
      const { sid, maxAgeSec } = createSession(db, user.id, user.role, {
        ip: req.ip, userAgent: req.headers['user-agent']
      });
      res.setHeader('Set-Cookie', buildSessionCookie(sid, maxAgeSec, config.nodeEnv === 'production'));
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
      audit(db, { actor_user_id: user.id, actor_role: user.role, action: 'auth.login',
        entity_type: 'user', entity_id: user.id, country_id: user.country_id,
        ip: req.ip, user_agent: req.headers['user-agent'] });

      res.json({
        ok: true,
        user: {
          id: user.id, role: user.role, full_name: user.full_name,
          email: user.email, country_id: user.country_id,
          mfa_enabled: !!user.mfa_enabled
        }
      });
    } catch (e) { next(e); }
  });

  r.post('/logout', requireAuth, (req, res, next) => {
    try {
      revokeSession(db, req.session.id);
      res.setHeader('Set-Cookie', clearSessionCookie());
      audit(db, { actor_user_id: req.user.id, actor_role: req.user.role, action: 'auth.logout',
        entity_type: 'user', entity_id: req.user.id,
        ip: req.ip, user_agent: req.headers['user-agent'] });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

  return r;
}

module.exports = { routes };