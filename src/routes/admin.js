const express = require('express');
const { requireRole } = require('../middleware/auth');
const { Errors } = require('../errors');
const { audit } = require('../audit');
const { SERVICE_CODES } = require('../countries/config');

const SETTINGS_VALIDATORS = {
  tax_rate_bp: (v) => Number.isInteger(v) && v >= 0 && v <= 10000,
  tax_label: (v) => typeof v === 'string' && v.length > 0 && v.length <= 20,
  cancellation_fee_minor: (v) => Number.isInteger(v) && v >= 0,
  free_cancel_seconds: (v) => Number.isInteger(v) && v >= 0,
  driver_acceptance_timeout_sec: (v) => Number.isInteger(v) && v > 0 && v <= 300,
  max_dispatch_radius_km: (v) => Number.isInteger(v) && v > 0 && v <= 200,
  driver_pickup_max_km: (v) => Number.isInteger(v) && v > 0 && v <= 100,
  support_phone: (v) => v === null || (typeof v === 'string' && v.length <= 30),
  support_email: (v) => v === null || (typeof v === 'string' && v.length <= 100),
  invoice_company_name: (v) => v === null || (typeof v === 'string' && v.length <= 100),
  invoice_company_address: (v) => v === null || (typeof v === 'string' && v.length <= 500),
  invoice_tax_id: (v) => v === null || (typeof v === 'string' && v.length <= 50),
  contact_privacy_mode: (v) => ['show_number', 'mask', 'hidden'].includes(v),
  enabled_languages: (v) => typeof v === 'string' && /^[a-z]{2}(,[a-z]{2})*$/.test(v)
};

const SERVICE_VALIDATORS = {
  is_enabled: (v) => v === 0 || v === 1 || v === true || v === false,
  base_fare_minor: (v) => Number.isInteger(v) && v >= 0,
  per_km_minor: (v) => Number.isInteger(v) && v >= 0,
  fast_surcharge_minor: (v) => Number.isInteger(v) && v >= 0,
  min_fare_minor: (v) => Number.isInteger(v) && v >= 0
};

function routes(db) {
  const r = express.Router();

  r.get('/whoami', requireRole('super_admin', 'country_admin'), (req, res) => {
    res.json({ user: req.user });
  });

  r.post('/users/:id/force-logout', requireRole('super_admin', 'country_admin'), (req, res, next) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) return next(Errors.validation('invalid_user_id'));

    const target = db.prepare('SELECT id, role, country_id FROM users WHERE id = ?').get(targetId);
    if (!target) return next(Errors.notFound('user_not_found'));

    if (req.user.role === 'country_admin') {
      const isSelf = target.id === req.user.id;
      const isSameCountry = target.country_id === req.user.country_id;
      const isAdminRole = target.role === 'super_admin' || target.role === 'country_admin';
      if (!isSelf) {
        if (!isSameCountry) return next(Errors.forbidden('cross_country_forbidden'));
        if (isAdminRole) return next(Errors.forbidden('cannot_target_admin'));
      }
    }

    const now = new Date().toISOString();
    const changes = db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(now, targetId).changes;

    audit(db, {
      actor_user_id: req.user.id, actor_role: req.user.role,
      action: 'admin.force_logout', entity_type: 'user', entity_id: targetId,
      country_id: target.country_id,
      metadata: { revoked: changes },
      ip: req.ip, user_agent: req.headers['user-agent']
    });

    res.json({ ok: true, revoked: Number(changes) });
  });

  // ---------- Country Admin scoped endpoints ----------
  r.get('/country', requireRole('country_admin'), (req, res, next) => {
    const countryId = req.user.country_id;
    if (!countryId) return next(Errors.forbidden('no_country_assigned'));
    const country = db.prepare('SELECT * FROM countries WHERE id = ?').get(countryId);
    if (!country) return next(Errors.notFound('country_not_found'));
    const settings = db.prepare('SELECT * FROM country_settings WHERE country_id = ?').get(countryId);
    const services = db.prepare('SELECT * FROM country_services WHERE country_id = ? ORDER BY service_code').all(countryId);
    res.json({ country, settings, services });
  });

  r.patch('/country/settings', requireRole('country_admin'), (req, res, next) => {
    try {
      const countryId = req.user.country_id;
      if (!countryId) return next(Errors.forbidden('no_country_assigned'));

      const body = req.body || {};
      if ('country_id' in body) {
        audit(db, {
          actor_user_id: req.user.id, actor_role: req.user.role,
          action: 'admin.cross_country_attempt', entity_type: 'country_settings',
          entity_id: countryId, country_id: countryId,
          metadata: { field: 'country_id', attempted_value: body.country_id },
          ip: req.ip, user_agent: req.headers['user-agent']
        });
        return next(Errors.crossCountryForbidden());
      }

      const updates = {};
      for (const k of Object.keys(body)) {
        if (!Object.prototype.hasOwnProperty.call(SETTINGS_VALIDATORS, k)) {
          return next(Errors.validation('invalid_field', { field: k }));
        }
        if (!SETTINGS_VALIDATORS[k](body[k])) {
          return next(Errors.validation('invalid_value', { field: k }));
        }
        updates[k] = body[k];
      }
      if (Object.keys(updates).length === 0) return next(Errors.validation('nothing_to_update'));

      const setClause = Object.keys(updates).map((k) => k + ' = ?').join(', ');
      db.prepare(
        'UPDATE country_settings SET ' + setClause + ', updated_at = ?, updated_by_user_id = ? WHERE country_id = ?'
      ).run(...Object.values(updates), new Date().toISOString(), req.user.id, countryId);

      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'admin.country_settings_updated', entity_type: 'country_settings',
        entity_id: countryId, country_id: countryId,
        metadata: { fields: Object.keys(updates) },
        ip: req.ip, user_agent: req.headers['user-agent']
      });

      const updated = db.prepare('SELECT * FROM country_settings WHERE country_id = ?').get(countryId);
      res.json({ settings: updated });
    } catch (e) { next(e); }
  });

  r.patch('/country/services/:code', requireRole('country_admin'), (req, res, next) => {
    try {
      const countryId = req.user.country_id;
      if (!countryId) return next(Errors.forbidden('no_country_assigned'));

      const code = String(req.params.code || '').toLowerCase();
      if (!SERVICE_CODES.includes(code)) return next(Errors.validation('invalid_service_code'));

      const body = req.body || {};
      if ('country_id' in body || 'service_code' in body) {
        audit(db, {
          actor_user_id: req.user.id, actor_role: req.user.role,
          action: 'admin.cross_country_attempt', entity_type: 'country_services',
          entity_id: countryId, country_id: countryId,
          metadata: { attempted_fields: Object.keys(body).filter((k) => k === 'country_id' || k === 'service_code') },
          ip: req.ip, user_agent: req.headers['user-agent']
        });
        return next(Errors.crossCountryForbidden());
      }

      const updates = {};
      for (const k of Object.keys(body)) {
        if (!Object.prototype.hasOwnProperty.call(SERVICE_VALIDATORS, k)) {
          return next(Errors.validation('invalid_field', { field: k }));
        }
        if (!SERVICE_VALIDATORS[k](body[k])) {
          return next(Errors.validation('invalid_value', { field: k }));
        }
        updates[k] = k === 'is_enabled' ? (body[k] ? 1 : 0) : body[k];
      }
      if (Object.keys(updates).length === 0) return next(Errors.validation('nothing_to_update'));

      const existing = db.prepare('SELECT * FROM country_services WHERE country_id = ? AND service_code = ?').get(countryId, code);
      if (!existing) return next(Errors.notFound('service_not_found'));

      const setClause = Object.keys(updates).map((k) => k + ' = ?').join(', ');
      db.prepare(
        'UPDATE country_services SET ' + setClause + ', updated_at = ?, updated_by_user_id = ? WHERE country_id = ? AND service_code = ?'
      ).run(...Object.values(updates), new Date().toISOString(), req.user.id, countryId, code);

      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'admin.country_service_updated', entity_type: 'country_services',
        entity_id: countryId, country_id: countryId,
        metadata: { service_code: code, fields: Object.keys(updates) },
        ip: req.ip, user_agent: req.headers['user-agent']
      });

      const updated = db.prepare('SELECT * FROM country_services WHERE country_id = ? AND service_code = ?').get(countryId, code);
      res.json({ service: updated });
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { routes };