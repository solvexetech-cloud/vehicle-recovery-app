const express = require('express');
const { requireRole } = require('../middleware/auth');
const { Errors } = require('../errors');
const { audit } = require('../audit');

const VEHICLE_CATEGORIES = new Set([
  'sedan_hatchback','suv','pickup','van','bus','truck','heavy_commercial','motorcycle','three_wheeler'
]);
const PHONE_RE = /^[\d+\-\s()]{6,30}$/;

function isValidName(s) {
  return typeof s === 'string' && s.trim().length >= 2 && s.trim().length <= 100;
}
function isValidPhone(s) {
  if (s === null || s === undefined || s === '') return true;
  return typeof s === 'string' && PHONE_RE.test(s);
}
function isValidLat(v) { return typeof v === 'number' && isFinite(v) && v >= -90 && v <= 90; }
function isValidLng(v) { return typeof v === 'number' && isFinite(v) && v >= -180 && v <= 180; }

function routes(db) {
  const r = express.Router();
  const guard = requireRole('customer');
  r.use(guard);

  // ---- helpers ----
  function getLimits(countryId) {
    const row = db.prepare(
      'SELECT max_saved_vehicles, max_saved_destinations FROM country_settings WHERE country_id = ?'
    ).get(countryId);
    return {
      max_saved_vehicles: row ? row.max_saved_vehicles : 5,
      max_saved_destinations: row ? row.max_saved_destinations : 10
    };
  }
  function countVehicles(customerId) {
    return db.prepare('SELECT COUNT(*) AS n FROM customer_vehicles WHERE customer_id = ?').get(customerId).n;
  }
  function countDestinations(customerId) {
    return db.prepare('SELECT COUNT(*) AS n FROM customer_destinations WHERE customer_id = ?').get(customerId).n;
  }
  function getOwnedVehicle(customerId, vehicleId) {
    return db.prepare('SELECT * FROM customer_vehicles WHERE id = ? AND customer_id = ?').get(vehicleId, customerId);
  }
  function getOwnedDestination(customerId, destId) {
    return db.prepare('SELECT * FROM customer_destinations WHERE id = ? AND customer_id = ?').get(destId, customerId);
  }

  // ---- profile ----
  r.get('/profile', (req, res, next) => {
    try {
      const user = db.prepare(
        'SELECT id, country_id, role, full_name, email, phone, status, created_at, last_login_at FROM users WHERE id = ?'
      ).get(req.user.id);
      if (!user) return next(Errors.notFound('user_not_found'));
      const country = db.prepare(
        'SELECT code, name_en, currency_code, currency_symbol, dial_code, timezone, default_language FROM countries WHERE id = ?'
      ).get(user.country_id);
      const limits = getLimits(user.country_id);
      const vehicle_count = countVehicles(user.id);
      const destination_count = countDestinations(user.id);
      res.json({ profile: user, country, limits, vehicle_count, destination_count });
    } catch (e) { next(e); }
  });

  r.patch('/profile', (req, res, next) => {
    try {
      const body = req.body || {};
      const updates = {};
      if ('full_name' in body) {
        if (!isValidName(body.full_name)) return next(Errors.validation('invalid_full_name'));
        updates.full_name = body.full_name.trim();
      }
      if ('phone' in body) {
        if (!isValidPhone(body.phone)) return next(Errors.validation('invalid_phone'));
        updates.phone = (body.phone === '' || body.phone === null) ? null : body.phone;
      }
      if (Object.keys(updates).length === 0) return next(Errors.validation('nothing_to_update'));

      const setClause = Object.keys(updates).map((k) => k + ' = ?').join(', ');
      db.prepare('UPDATE users SET ' + setClause + ', updated_at = ? WHERE id = ?')
        .run(...Object.values(updates), new Date().toISOString(), req.user.id);

      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'customer.profile_updated', entity_type: 'user', entity_id: req.user.id,
        country_id: req.user.country_id, metadata: { fields: Object.keys(updates) },
        ip: req.ip, user_agent: req.headers['user-agent']
      });

      const updated = db.prepare(
        'SELECT id, country_id, role, full_name, email, phone, status, created_at, last_login_at FROM users WHERE id = ?'
      ).get(req.user.id);
      res.json({ profile: updated });
    } catch (e) { next(e); }
  });

  // ---- vehicles ----
  r.get('/vehicles', (req, res) => {
    const vehicles = db.prepare(
      'SELECT * FROM customer_vehicles WHERE customer_id = ? ORDER BY is_default DESC, id ASC'
    ).all(req.user.id);
    res.json({ vehicles });
  });

  r.post('/vehicles', (req, res, next) => {
    try {
      const body = req.body || {};
      const category = String(body.category || '').toLowerCase();
      if (!VEHICLE_CATEGORIES.has(category)) {
        return next(Errors.validation('invalid_category', { allowed: [...VEHICLE_CATEGORIES] }));
      }
      if (!body.registration_number || typeof body.registration_number !== 'string' ||
          body.registration_number.trim().length < 1 || body.registration_number.trim().length > 20) {
        return next(Errors.validation('invalid_registration_number'));
      }
      const make = body.make === null || body.make === undefined ? null :
        (typeof body.make === 'string' && body.make.length <= 50 ? body.make : null);
      if (make === null && body.make !== null && body.make !== undefined) return next(Errors.validation('invalid_make'));
      const model = body.model === null || body.model === undefined ? null :
        (typeof body.model === 'string' && body.model.length <= 50 ? body.model : null);
      if (model === null && body.model !== null && body.model !== undefined) return next(Errors.validation('invalid_model'));
      const colour = body.colour === null || body.colour === undefined ? null :
        (typeof body.colour === 'string' && body.colour.length <= 30 ? body.colour : null);
      if (colour === null && body.colour !== null && body.colour !== undefined) return next(Errors.validation('invalid_colour'));

      const limits = getLimits(req.user.country_id);
      const current = countVehicles(req.user.id);
      if (current >= limits.max_saved_vehicles) {
        return next(Errors.conflict('max_saved_vehicles_reached', { limit: limits.max_saved_vehicles }));
      }

      const isFirst = current === 0;
      const wantDefault = !!body.is_default;
      const willBeDefault = wantDefault || isFirst;

      if (willBeDefault) {
        db.prepare('UPDATE customer_vehicles SET is_default = 0 WHERE customer_id = ?').run(req.user.id);
      }

      const now = new Date().toISOString();
      const r1 = db.prepare(
        'INSERT INTO customer_vehicles (customer_id, country_id, category, make, model, colour, registration_number, is_default, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(req.user.id, req.user.country_id, category, make, model, colour,
            body.registration_number.trim(), willBeDefault ? 1 : 0, now, now);

      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'customer.vehicle_added', entity_type: 'customer_vehicle',
        entity_id: Number(r1.lastInsertRowid), country_id: req.user.country_id,
        metadata: { category, is_default: willBeDefault },
        ip: req.ip, user_agent: req.headers['user-agent']
      });

      const created = db.prepare('SELECT * FROM customer_vehicles WHERE id = ?').get(r1.lastInsertRowid);
      res.status(201).json({ vehicle: created });
    } catch (e) { next(e); }
  });

  r.patch('/vehicles/:id', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const existing = getOwnedVehicle(req.user.id, id);
      if (!existing) return next(Errors.notFound('vehicle_not_found'));

      const body = req.body || {};
      const updates = {};
      if ('category' in body) {
        const cat = String(body.category).toLowerCase();
        if (!VEHICLE_CATEGORIES.has(cat)) return next(Errors.validation('invalid_category'));
        updates.category = cat;
      }
      if ('make' in body) {
        if (body.make !== null && (typeof body.make !== 'string' || body.make.length > 50)) return next(Errors.validation('invalid_make'));
        updates.make = body.make;
      }
      if ('model' in body) {
        if (body.model !== null && (typeof body.model !== 'string' || body.model.length > 50)) return next(Errors.validation('invalid_model'));
        updates.model = body.model;
      }
      if ('colour' in body) {
        if (body.colour !== null && (typeof body.colour !== 'string' || body.colour.length > 30)) return next(Errors.validation('invalid_colour'));
        updates.colour = body.colour;
      }
      if ('registration_number' in body) {
        if (typeof body.registration_number !== 'string' ||
            body.registration_number.trim().length < 1 || body.registration_number.trim().length > 20) {
          return next(Errors.validation('invalid_registration_number'));
        }
        updates.registration_number = body.registration_number.trim();
      }
      if ('is_default' in body) {
        if (body.is_default) {
          db.prepare('UPDATE customer_vehicles SET is_default = 0 WHERE customer_id = ? AND id != ?')
            .run(req.user.id, id);
          updates.is_default = 1;
        } else {
          updates.is_default = 0;
        }
      }
      if (Object.keys(updates).length === 0) return next(Errors.validation('nothing_to_update'));

      const setClause = Object.keys(updates).map((k) => k + ' = ?').join(', ');
      db.prepare('UPDATE customer_vehicles SET ' + setClause + ', updated_at = ? WHERE id = ? AND customer_id = ?')
        .run(...Object.values(updates), new Date().toISOString(), id, req.user.id);

      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'customer.vehicle_updated', entity_type: 'customer_vehicle', entity_id: id,
        country_id: req.user.country_id, metadata: { fields: Object.keys(updates) },
        ip: req.ip, user_agent: req.headers['user-agent']
      });

      const updated = db.prepare('SELECT * FROM customer_vehicles WHERE id = ?').get(id);
      res.json({ vehicle: updated });
    } catch (e) { next(e); }
  });

  r.post('/vehicles/:id/default', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const existing = getOwnedVehicle(req.user.id, id);
      if (!existing) return next(Errors.notFound('vehicle_not_found'));

      const now = new Date().toISOString();
      db.prepare('UPDATE customer_vehicles SET is_default = 0 WHERE customer_id = ? AND id != ?').run(req.user.id, id);
      db.prepare('UPDATE customer_vehicles SET is_default = 1, updated_at = ? WHERE id = ? AND customer_id = ?')
        .run(now, id, req.user.id);

      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'customer.vehicle_set_default', entity_type: 'customer_vehicle', entity_id: id,
        country_id: req.user.country_id,
        ip: req.ip, user_agent: req.headers['user-agent']
      });

      const updated = db.prepare('SELECT * FROM customer_vehicles WHERE id = ?').get(id);
      res.json({ vehicle: updated });
    } catch (e) { next(e); }
  });

  r.delete('/vehicles/:id', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const existing = getOwnedVehicle(req.user.id, id);
      if (!existing) return next(Errors.notFound('vehicle_not_found'));

      db.prepare('DELETE FROM customer_vehicles WHERE id = ? AND customer_id = ?').run(id, req.user.id);

      if (existing.is_default === 1) {
        const nextV = db.prepare('SELECT id FROM customer_vehicles WHERE customer_id = ? ORDER BY id ASC LIMIT 1')
          .get(req.user.id);
        if (nextV) {
          db.prepare('UPDATE customer_vehicles SET is_default = 1, updated_at = ? WHERE id = ?')
            .run(new Date().toISOString(), nextV.id);
        }
      }

      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'customer.vehicle_deleted', entity_type: 'customer_vehicle', entity_id: id,
        country_id: req.user.country_id,
        ip: req.ip, user_agent: req.headers['user-agent']
      });

      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---- destinations ----
  r.get('/destinations', (req, res) => {
    const destinations = db.prepare(
      'SELECT * FROM customer_destinations WHERE customer_id = ? ORDER BY id ASC'
    ).all(req.user.id);
    res.json({ destinations });
  });

  r.post('/destinations', (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.label || typeof body.label !== 'string' || body.label.trim().length < 1 || body.label.trim().length > 50) {
        return next(Errors.validation('invalid_label'));
      }
      if (!body.address || typeof body.address !== 'string' || body.address.trim().length < 1 || body.address.trim().length > 200) {
        return next(Errors.validation('invalid_address'));
      }
      if (!isValidLat(body.lat)) return next(Errors.validation('invalid_lat'));
      if (!isValidLng(body.lng)) return next(Errors.validation('invalid_lng'));
      if (!isValidPhone(body.contact_phone)) return next(Errors.validation('invalid_contact_phone'));

      const limits = getLimits(req.user.country_id);
      const current = countDestinations(req.user.id);
      if (current >= limits.max_saved_destinations) {
        return next(Errors.conflict('max_saved_destinations_reached', { limit: limits.max_saved_destinations }));
      }

      const now = new Date().toISOString();
      const r1 = db.prepare(
        'INSERT INTO customer_destinations (customer_id, country_id, label, address, lat, lng, contact_phone, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(req.user.id, req.user.country_id, body.label.trim(), body.address.trim(),
            body.lat, body.lng, body.contact_phone || null, now, now);

      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'customer.destination_added', entity_type: 'customer_destination',
        entity_id: Number(r1.lastInsertRowid), country_id: req.user.country_id,
        metadata: { label: body.label.trim() },
        ip: req.ip, user_agent: req.headers['user-agent']
      });

      const created = db.prepare('SELECT * FROM customer_destinations WHERE id = ?').get(r1.lastInsertRowid);
      res.status(201).json({ destination: created });
    } catch (e) { next(e); }
  });

  r.patch('/destinations/:id', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const existing = getOwnedDestination(req.user.id, id);
      if (!existing) return next(Errors.notFound('destination_not_found'));

      const body = req.body || {};
      const updates = {};
      if ('label' in body) {
        if (typeof body.label !== 'string' || body.label.trim().length < 1 || body.label.trim().length > 50) {
          return next(Errors.validation('invalid_label'));
        }
        updates.label = body.label.trim();
      }
      if ('address' in body) {
        if (typeof body.address !== 'string' || body.address.trim().length < 1 || body.address.trim().length > 200) {
          return next(Errors.validation('invalid_address'));
        }
        updates.address = body.address.trim();
      }
      if ('lat' in body) {
        if (!isValidLat(body.lat)) return next(Errors.validation('invalid_lat'));
        updates.lat = body.lat;
      }
      if ('lng' in body) {
        if (!isValidLng(body.lng)) return next(Errors.validation('invalid_lng'));
        updates.lng = body.lng;
      }
      if ('contact_phone' in body) {
        if (!isValidPhone(body.contact_phone)) return next(Errors.validation('invalid_contact_phone'));
        updates.contact_phone = (body.contact_phone === '' || body.contact_phone === null) ? null : body.contact_phone;
      }
      if (Object.keys(updates).length === 0) return next(Errors.validation('nothing_to_update'));

      const setClause = Object.keys(updates).map((k) => k + ' = ?').join(', ');
      db.prepare('UPDATE customer_destinations SET ' + setClause + ', updated_at = ? WHERE id = ? AND customer_id = ?')
        .run(...Object.values(updates), new Date().toISOString(), id, req.user.id);

      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'customer.destination_updated', entity_type: 'customer_destination', entity_id: id,
        country_id: req.user.country_id, metadata: { fields: Object.keys(updates) },
        ip: req.ip, user_agent: req.headers['user-agent']
      });

      const updated = db.prepare('SELECT * FROM customer_destinations WHERE id = ?').get(id);
      res.json({ destination: updated });
    } catch (e) { next(e); }
  });

  r.delete('/destinations/:id', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const existing = getOwnedDestination(req.user.id, id);
      if (!existing) return next(Errors.notFound('destination_not_found'));

      db.prepare('DELETE FROM customer_destinations WHERE id = ? AND customer_id = ?').run(id, req.user.id);

      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'customer.destination_deleted', entity_type: 'customer_destination', entity_id: id,
        country_id: req.user.country_id,
        ip: req.ip, user_agent: req.headers['user-agent']
      });

      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { routes };