const express = require('express');
const { Errors } = require('../errors');
const { requireRole } = require('../middleware/auth');
const { audit } = require('../audit');
const { hashPassword, isWeakPassword } = require('../auth');
const { ensureCountryConfig, SERVICE_CODES } = require('../countries/config');

const CODE_RE = /^[A-Z]{2}$/;
const CCY_RE = /^[A-Z]{3}$/;
const DIAL_RE = /^\+\d{1,4}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function routes(db, config) { // eslint-disable-line no-unused-vars
  const r = express.Router();
  const guard = requireRole('super_admin');

  r.get('/countries', guard, (req, res) => {
    const rows = db.prepare(
      'SELECT c.id, c.code, c.name_en, c.name_ar, c.currency_code, c.currency_symbol, ' +
      '       c.dial_code, c.timezone, c.default_language, c.is_active, ' +
      '       cs.tax_rate_bp, cs.contact_privacy_mode, ' +
      '       (SELECT COUNT(*) FROM country_services s WHERE s.country_id = c.id AND s.is_enabled = 1) AS services_enabled, ' +
      '       (SELECT COUNT(*) FROM users u WHERE u.country_id = c.id AND u.role = \'country_admin\' AND u.status = \'active\') AS country_admins ' +
      'FROM countries c LEFT JOIN country_settings cs ON cs.country_id = c.id ' +
      'ORDER BY c.code'
    ).all();
    res.json({ countries: rows });
  });

  r.get('/countries/:code', guard, (req, res, next) => {
    try {
      const code = String(req.params.code || '').toUpperCase();
      if (!CODE_RE.test(code)) return next(Errors.validation('invalid_country_code'));
      const c = db.prepare('SELECT * FROM countries WHERE code = ?').get(code);
      if (!c) return next(Errors.notFound('country_not_found'));
      ensureCountryConfig(db, c.id, { code: c.code });
      const settings = db.prepare('SELECT * FROM country_settings WHERE country_id = ?').get(c.id);
      const services = db.prepare('SELECT * FROM country_services WHERE country_id = ? ORDER BY service_code').all(c.id);
      res.json({ country: c, settings, services });
    } catch (e) { next(e); }
  });

  r.post('/countries', guard, (req, res, next) => {
    try {
      const body = req.body || {};
      const codeNorm = String(body.code || '').toUpperCase();
      if (!CODE_RE.test(codeNorm)) return next(Errors.validation('invalid_country_code'));
      if (!body.name_en || String(body.name_en).trim().length < 2) return next(Errors.validation('invalid_name_en'));
      const ccy = String(body.currency_code || '').toUpperCase();
      if (!CCY_RE.test(ccy)) return next(Errors.validation('invalid_currency_code'));
      if (!body.currency_symbol || String(body.currency_symbol).length > 8) return next(Errors.validation('invalid_currency_symbol'));
      if (!DIAL_RE.test(String(body.dial_code || ''))) return next(Errors.validation('invalid_dial_code'));
      if (!body.timezone || typeof body.timezone !== 'string') return next(Errors.validation('invalid_timezone'));

      if (db.prepare('SELECT id FROM countries WHERE code = ?').get(codeNorm)) {
        return next(Errors.conflict('country_code_exists'));
      }

      const tx = db.prepare(
        'INSERT INTO countries (code, name_en, name_ar, currency_code, currency_symbol, dial_code, timezone, default_language, is_active) ' +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'ar', 0)"
      ).run(codeNorm, String(body.name_en).trim(), body.name_ar || null, ccy,
            String(body.currency_symbol), String(body.dial_code), String(body.timezone));

      const countryId = Number(tx.lastInsertRowid);
      ensureCountryConfig(db, countryId, { code: codeNorm });

      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'admin.country_created', entity_type: 'country', entity_id: countryId,
        country_id: countryId, metadata: { code: codeNorm },
        ip: req.ip, user_agent: req.headers['user-agent']
      });

      const created = db.prepare('SELECT * FROM countries WHERE id = ?').get(countryId);
      res.status(201).json({ country: created });
    } catch (e) { next(e); }
  });

  r.patch('/countries/:code', guard, (req, res, next) => {
    try {
      const code = String(req.params.code || '').toUpperCase();
      if (!CODE_RE.test(code)) return next(Errors.validation('invalid_country_code'));
      const c = db.prepare('SELECT * FROM countries WHERE code = ?').get(code);
      if (!c) return next(Errors.notFound('country_not_found'));

      const body = req.body || {};
      const updates = {};
      if ('is_active' in body) updates.is_active = body.is_active ? 1 : 0;
      if ('name_en' in body && typeof body.name_en === 'string' && body.name_en.trim().length >= 2) updates.name_en = body.name_en.trim();
      if ('name_ar' in body) updates.name_ar = (typeof body.name_ar === 'string' && body.name_ar.length > 0) ? body.name_ar : null;
      if ('currency_symbol' in body && typeof body.currency_symbol === 'string' && body.currency_symbol.length > 0 && body.currency_symbol.length <= 8) updates.currency_symbol = body.currency_symbol;

      if (Object.keys(updates).length === 0) return next(Errors.validation('nothing_to_update'));

      const setClause = Object.keys(updates).map((k) => k + ' = ?').join(', ');
      db.prepare('UPDATE countries SET ' + setClause + ', updated_at = ? WHERE code = ?')
        .run(...Object.values(updates), new Date().toISOString(), code);

      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'admin.country_updated', entity_type: 'country', entity_id: c.id,
        country_id: c.id, metadata: { fields: Object.keys(updates) },
        ip: req.ip, user_agent: req.headers['user-agent']
      });

      const updated = db.prepare('SELECT * FROM countries WHERE code = ?').get(code);
      res.json({ country: updated });
    } catch (e) { next(e); }
  });

  r.get('/country-admins', guard, (req, res) => {
    const rows = db.prepare(
      'SELECT u.id, u.role, u.full_name, u.email, u.status, u.country_id, ' +
      '       c.code AS country_code, c.name_en AS country_name, u.created_at, u.last_login_at ' +
      'FROM users u LEFT JOIN countries c ON c.id = u.country_id ' +
      "WHERE u.role = 'country_admin' ORDER BY u.id"
    ).all();
    res.json({ country_admins: rows });
  });

  r.post('/country-admins', guard, async (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.email || !EMAIL_RE.test(body.email)) return next(Errors.validation('invalid_email'));
      const w = isWeakPassword(body.password);
      if (w.weak) return next(Errors.validation('weak_password', { reason: w.reason }));
      if (!body.full_name || String(body.full_name).trim().length < 2) return next(Errors.validation('invalid_full_name'));
      const codeNorm = String(body.country_code || '').toUpperCase();
      if (!CODE_RE.test(codeNorm)) return next(Errors.validation('invalid_country_code'));
      const country = db.prepare('SELECT * FROM countries WHERE code = ?').get(codeNorm);
      if (!country) return next(Errors.validation('invalid_country'));

      const normEmail = String(body.email).trim().toLowerCase();
      if (db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail)) {
        return next(Errors.conflict('email_already_registered'));
      }

      const pwHash = await hashPassword(body.password);
      const now = new Date().toISOString();
      let userId;
      try {
        const tx = db.prepare(
          "INSERT INTO users (country_id, role, full_name, email, password_hash, status, email_verified_at) VALUES (?, 'country_admin', ?, ?, ?, 'active', ?)"
        ).run(country.id, String(body.full_name).trim(), normEmail, pwHash, now);
        userId = Number(tx.lastInsertRowid);
      } catch (e) {
        if (/UNIQUE/i.test(e.message)) return next(Errors.conflict('email_already_registered'));
        throw e;
      }

      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'admin.country_admin_created', entity_type: 'user', entity_id: userId,
        country_id: country.id, metadata: { email: normEmail, country_code: codeNorm },
        ip: req.ip, user_agent: req.headers['user-agent']
      });

      const created = db.prepare(
        'SELECT u.id, u.role, u.full_name, u.email, u.status, u.country_id, c.code AS country_code, c.name_en AS country_name ' +
        'FROM users u LEFT JOIN countries c ON c.id = u.country_id WHERE u.id = ?'
      ).get(userId);

      res.status(201).json({ user: created });
    } catch (e) { next(e); }
  });

  r.patch('/country-admins/:id', guard, (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_user_id'));
      const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'country_admin'").get(id);
      if (!u) return next(Errors.notFound('country_admin_not_found'));

      const status = (req.body || {}).status;
      if (!['active', 'suspended'].includes(status)) return next(Errors.validation('invalid_status'));

      db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);

      if (status === 'suspended') {
        db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
          .run(new Date().toISOString(), id);
      }

      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'admin.country_admin_status_changed', entity_type: 'user', entity_id: id,
        country_id: u.country_id, metadata: { status },
        ip: req.ip, user_agent: req.headers['user-agent']
      });

      const updated = db.prepare(
        'SELECT u.id, u.role, u.full_name, u.email, u.status, u.country_id, c.code AS country_code, c.name_en AS country_name ' +
        'FROM users u LEFT JOIN countries c ON c.id = u.country_id WHERE u.id = ?'
      ).get(id);
      res.json({ user: updated });
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { routes, SERVICE_CODES };