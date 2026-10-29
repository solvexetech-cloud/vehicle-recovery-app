const express = require('express');
const { requireRole } = require('../middleware/auth');
const { Errors } = require('../errors');
const { audit } = require('../audit');

const VEHICLE_TYPES = new Set(['flatbed','wheel_lift','heavy_duty','roadside_assist']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[\d+\-\s()]{6,30}$/;
const PLATE_RE = /^[A-Za-z0-9\-\s]{1,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

function isNonEmpty(s, min = 1, max = 200) { return typeof s === 'string' && s.trim().length >= min && s.trim().length <= max; }
function isOptionalEmail(s) { return s === null || s === undefined || s === '' || (typeof s === 'string' && EMAIL_RE.test(s)); }
function isOptionalPhone(s) { return s === null || s === undefined || s === '' || (typeof s === 'string' && PHONE_RE.test(s)); }
function isOptionalIsoDate(s) { return s === null || s === undefined || s === '' || (typeof s === 'string' && DATE_RE.test(s)); }
function isOptionalYear(v) { return v === null || v === undefined || (Number.isInteger(v) && v >= 1980 && v <= 2100); }

function routes(db) {
  const r = express.Router();
  const guard = requireRole('agency');
  r.use(guard);

  function getAgency(userId) {
    return db.prepare('SELECT * FROM agencies WHERE user_id = ?').get(userId);
  }
  function getOwnedVehicle(agencyId, vehicleId) {
    return db.prepare('SELECT * FROM recovery_vehicles WHERE id = ? AND agency_id = ?').get(vehicleId, agencyId);
  }
  function getOwnedDriver(agencyId, driverId) {
    return db.prepare('SELECT * FROM drivers WHERE id = ? AND agency_id = ?').get(driverId, agencyId);
  }
  function countBookingsForVehicle(vehicleId) {
    try {
      return db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE recovery_vehicle_id = ?').get(vehicleId).n;
    } catch (_) { return 0; }
  }

  // ---------- profile ----------
  r.get('/profile', (req, res, next) => {
    try {
      const agency = getAgency(req.user.id);
      if (!agency) return next(Errors.notFound('agency_profile_not_found'));
      const country = db.prepare(
        'SELECT code, name_en, currency_code, currency_symbol, dial_code, timezone FROM countries WHERE id = ?'
      ).get(agency.country_id);
      const drivers_count = db.prepare('SELECT COUNT(*) AS n FROM drivers WHERE agency_id = ?').get(agency.id).n;
      const vehicles_count = db.prepare('SELECT COUNT(*) AS n FROM recovery_vehicles WHERE agency_id = ?').get(agency.id).n;
      const authorizations_count = db.prepare(
        'SELECT COUNT(*) AS n FROM driver_vehicles dv JOIN drivers d ON d.id = dv.driver_id WHERE d.agency_id = ? AND dv.revoked_at IS NULL'
      ).get(agency.id).n;
      res.json({
        profile: {
          id: agency.id, user_id: agency.user_id, country_id: agency.country_id,
          legal_name: agency.legal_name, display_name: agency.display_name,
          contact_email: agency.contact_email, contact_phone: agency.contact_phone,
          status: agency.status, rejection_reason: agency.rejection_reason,
          created_at: agency.created_at
        },
        country,
        counts: { drivers: drivers_count, vehicles: vehicles_count, active_authorizations: authorizations_count }
      });
    } catch (e) { next(e); }
  });

  r.patch('/profile', (req, res, next) => {
    try {
      const agency = getAgency(req.user.id);
      if (!agency) return next(Errors.notFound('agency_profile_not_found'));
      if (agency.status === 'suspended' || agency.status === 'rejected') {
        return next(Errors.forbidden('agency_not_active'));
      }
      const body = req.body || {};
      const updates = {};
      if ('display_name' in body) {
        if (!isNonEmpty(body.display_name, 2, 100)) return next(Errors.validation('invalid_display_name'));
        updates.display_name = body.display_name.trim();
      }
      if ('legal_name' in body) {
        if (!isNonEmpty(body.legal_name, 2, 150)) return next(Errors.validation('invalid_legal_name'));
        updates.legal_name = body.legal_name.trim();
      }
      if ('contact_email' in body) {
        if (!isOptionalEmail(body.contact_email)) return next(Errors.validation('invalid_contact_email'));
        updates.contact_email = (body.contact_email === '' || body.contact_email === null) ? null : body.contact_email;
      }
      if ('contact_phone' in body) {
        if (!isOptionalPhone(body.contact_phone)) return next(Errors.validation('invalid_contact_phone'));
        updates.contact_phone = (body.contact_phone === '' || body.contact_phone === null) ? null : body.contact_phone;
      }
      if (Object.keys(updates).length === 0) return next(Errors.validation('nothing_to_update'));

      const setClause = Object.keys(updates).map((k) => k + ' = ?').join(', ');
      db.prepare('UPDATE agencies SET ' + setClause + ', updated_at = ? WHERE id = ?')
        .run(...Object.values(updates), new Date().toISOString(), agency.id);

      audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'agency.profile_updated', entity_type: 'agency', entity_id: agency.id,
        country_id: agency.country_id, metadata: { fields: Object.keys(updates) },
        ip: req.ip, user_agent: req.headers['user-agent'] });

      const updated = db.prepare('SELECT * FROM agencies WHERE id = ?').get(agency.id);
      res.json({ profile: updated });
    } catch (e) { next(e); }
  });

  // ---------- fleet ----------
  r.get('/vehicles', (req, res, next) => {
    try {
      const agency = getAgency(req.user.id);
      if (!agency) return next(Errors.notFound('agency_profile_not_found'));
      const vehicles = db.prepare(
        'SELECT * FROM recovery_vehicles WHERE agency_id = ? ORDER BY id ASC'
      ).all(agency.id);
      res.json({ vehicles });
    } catch (e) { next(e); }
  });

  r.post('/vehicles', (req, res, next) => {
    try {
      const agency = getAgency(req.user.id);
      if (!agency) return next(Errors.notFound('agency_profile_not_found'));
      if (agency.status === 'suspended' || agency.status === 'rejected') {
        return next(Errors.forbidden('agency_not_active'));
      }
      const body = req.body || {};
      const vehicleType = String(body.vehicle_type || '').toLowerCase();
      if (!VEHICLE_TYPES.has(vehicleType)) {
        return next(Errors.validation('invalid_vehicle_type', { allowed: [...VEHICLE_TYPES] }));
      }
      if (!PLATE_RE.test(String(body.plate_number || ''))) {
        return next(Errors.validation('invalid_plate_number'));
      }
      const plate = String(body.plate_number).trim();

      const dup = db.prepare('SELECT id FROM recovery_vehicles WHERE country_id = ? AND plate_number = ?')
        .get(agency.country_id, plate);
      if (dup) return next(Errors.conflict('plate_already_registered_in_country'));

      if (!isOptionalYear(body.year)) return next(Errors.validation('invalid_year'));
      if (!isOptionalIsoDate(body.insurance_expires_at)) return next(Errors.validation('invalid_insurance_expires_at'));
      if (!isOptionalIsoDate(body.inspection_expires_at)) return next(Errors.validation('invalid_inspection_expires_at'));

      const now = new Date().toISOString();
      const r1 = db.prepare(
        'INSERT INTO recovery_vehicles (country_id, agency_id, plate_number, vehicle_type, make, model, year, status, ' +
        'insurance_expires_at, inspection_expires_at, created_at, updated_at) ' +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)"
      ).run(
        agency.country_id, agency.id, plate, vehicleType,
        body.make || null, body.model || null,
        body.year !== undefined ? body.year : null,
        body.insurance_expires_at || null,
        body.inspection_expires_at || null,
        now, now
      );

      audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'agency.vehicle_added', entity_type: 'recovery_vehicle',
        entity_id: Number(r1.lastInsertRowid), country_id: agency.country_id,
        metadata: { plate_number: plate, vehicle_type: vehicleType },
        ip: req.ip, user_agent: req.headers['user-agent'] });

      const created = db.prepare('SELECT * FROM recovery_vehicles WHERE id = ?').get(r1.lastInsertRowid);
      res.status(201).json({ vehicle: created });
    } catch (e) { next(e); }
  });

  r.patch('/vehicles/:id', (req, res, next) => {
    try {
      const agency = getAgency(req.user.id);
      if (!agency) return next(Errors.notFound('agency_profile_not_found'));
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const vehicle = getOwnedVehicle(agency.id, id);
      if (!vehicle) return next(Errors.notFound('vehicle_not_found'));
      if (vehicle.status === 'suspended') return next(Errors.forbidden('vehicle_suspended'));

      const body = req.body || {};
      if ('status' in body) {
        // Only admin can change approval status
        return next(Errors.forbidden('status_change_by_agency_not_allowed'));
      }

      const updates = {};
      if ('vehicle_type' in body) {
        const t = String(body.vehicle_type).toLowerCase();
        if (!VEHICLE_TYPES.has(t)) return next(Errors.validation('invalid_vehicle_type'));
        updates.vehicle_type = t;
      }
      if ('plate_number' in body) {
        if (!PLATE_RE.test(String(body.plate_number))) return next(Errors.validation('invalid_plate_number'));
        const newPlate = String(body.plate_number).trim();
        if (newPlate !== vehicle.plate_number) {
          const dup = db.prepare('SELECT id FROM recovery_vehicles WHERE country_id = ? AND plate_number = ? AND id != ?')
            .get(agency.country_id, newPlate, id);
          if (dup) return next(Errors.conflict('plate_already_registered_in_country'));
        }
        updates.plate_number = newPlate;
      }
      if ('make' in body) {
        if (body.make !== null && (typeof body.make !== 'string' || body.make.length > 50)) return next(Errors.validation('invalid_make'));
        updates.make = body.make;
      }
      if ('model' in body) {
        if (body.model !== null && (typeof body.model !== 'string' || body.model.length > 50)) return next(Errors.validation('invalid_model'));
        updates.model = body.model;
      }
      if ('year' in body) {
        if (!isOptionalYear(body.year)) return next(Errors.validation('invalid_year'));
        updates.year = body.year;
      }
      if ('insurance_expires_at' in body) {
        if (!isOptionalIsoDate(body.insurance_expires_at)) return next(Errors.validation('invalid_insurance_expires_at'));
        updates.insurance_expires_at = body.insurance_expires_at || null;
      }
      if ('inspection_expires_at' in body) {
        if (!isOptionalIsoDate(body.inspection_expires_at)) return next(Errors.validation('invalid_inspection_expires_at'));
        updates.inspection_expires_at = body.inspection_expires_at || null;
      }
      if (Object.keys(updates).length === 0) return next(Errors.validation('nothing_to_update'));

      const setClause = Object.keys(updates).map((k) => k + ' = ?').join(', ');
      db.prepare('UPDATE recovery_vehicles SET ' + setClause + ', updated_at = ? WHERE id = ? AND agency_id = ?')
        .run(...Object.values(updates), new Date().toISOString(), id, agency.id);

      audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'agency.vehicle_updated', entity_type: 'recovery_vehicle', entity_id: id,
        country_id: agency.country_id, metadata: { fields: Object.keys(updates) },
        ip: req.ip, user_agent: req.headers['user-agent'] });

      const updated = db.prepare('SELECT * FROM recovery_vehicles WHERE id = ?').get(id);
      res.json({ vehicle: updated });
    } catch (e) { next(e); }
  });

  r.delete('/vehicles/:id', (req, res, next) => {
    try {
      const agency = getAgency(req.user.id);
      if (!agency) return next(Errors.notFound('agency_profile_not_found'));
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const vehicle = getOwnedVehicle(agency.id, id);
      if (!vehicle) return next(Errors.notFound('vehicle_not_found'));

      const activeAuth = db.prepare(
        'SELECT COUNT(*) AS n FROM driver_vehicles WHERE recovery_vehicle_id = ? AND revoked_at IS NULL'
      ).get(id).n;
      if (activeAuth > 0) return next(Errors.conflict('vehicle_has_active_authorizations', { count: activeAuth }));

      const bookingRefs = countBookingsForVehicle(id);
      if (bookingRefs > 0) return next(Errors.conflict('vehicle_referenced_by_bookings', { count: bookingRefs }));

      // Also block if any driver current_vehicle points at it
      const current = db.prepare('SELECT COUNT(*) AS n FROM drivers WHERE current_vehicle_id = ?').get(id).n;
      if (current > 0) return next(Errors.conflict('vehicle_is_driver_current', { count: current }));

      db.prepare('DELETE FROM recovery_vehicles WHERE id = ? AND agency_id = ?').run(id, agency.id);

      audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'agency.vehicle_deleted', entity_type: 'recovery_vehicle', entity_id: id,
        country_id: agency.country_id,
        ip: req.ip, user_agent: req.headers['user-agent'] });

      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---------- drivers ----------
  r.get('/drivers', (req, res, next) => {
    try {
      const agency = getAgency(req.user.id);
      if (!agency) return next(Errors.notFound('agency_profile_not_found'));
      const drivers = db.prepare(
        'SELECT d.id, d.user_id, d.status, d.is_online, d.current_vehicle_id, d.rating_avg, d.rating_count, ' +
        '       u.full_name, u.email, u.phone ' +
        'FROM drivers d JOIN users u ON u.id = d.user_id ' +
        'WHERE d.agency_id = ? ORDER BY d.id'
      ).all(agency.id);

      const authsByDriver = {};
      for (const d of drivers) {
        authsByDriver[d.id] = db.prepare(
          'SELECT dv.recovery_vehicle_id, rv.plate_number, rv.vehicle_type ' +
          'FROM driver_vehicles dv JOIN recovery_vehicles rv ON rv.id = dv.recovery_vehicle_id ' +
          'WHERE dv.driver_id = ? AND dv.revoked_at IS NULL ORDER BY dv.recovery_vehicle_id'
        ).all(d.id);
      }
      res.json({ drivers: drivers.map((d) => ({ ...d, authorized_vehicles: authsByDriver[d.id] })) });
    } catch (e) { next(e); }
  });

  r.post('/drivers/:driverId/authorize', (req, res, next) => {
    try {
      const agency = getAgency(req.user.id);
      if (!agency) return next(Errors.notFound('agency_profile_not_found'));
      const driverId = Number(req.params.driverId);
      if (!Number.isInteger(driverId) || driverId <= 0) return next(Errors.validation('invalid_driver_id'));
      const driver = getOwnedDriver(agency.id, driverId);
      if (!driver) return next(Errors.notFound('driver_not_found'));

      const body = req.body || {};
      const vehicleId = Number(body.recovery_vehicle_id);
      if (!Number.isInteger(vehicleId) || vehicleId <= 0) return next(Errors.validation('invalid_recovery_vehicle_id'));
      const vehicle = getOwnedVehicle(agency.id, vehicleId);
      if (!vehicle) return next(Errors.notFound('vehicle_not_found'));
      if (vehicle.status !== 'approved') return next(Errors.validation('vehicle_not_approved'));

      const existing = db.prepare(
        'SELECT * FROM driver_vehicles WHERE driver_id = ? AND recovery_vehicle_id = ?'
      ).get(driverId, vehicleId);

      const now = new Date().toISOString();
      if (existing && existing.revoked_at === null) {
        return res.json({ ok: true, already_authorized: true });
      }
      if (existing && existing.revoked_at !== null) {
        db.prepare('UPDATE driver_vehicles SET revoked_at = NULL, authorized_at = ? WHERE driver_id = ? AND recovery_vehicle_id = ?')
          .run(now, driverId, vehicleId);
      } else {
        db.prepare('INSERT INTO driver_vehicles (driver_id, recovery_vehicle_id, authorized_at) VALUES (?, ?, ?)')
          .run(driverId, vehicleId, now);
      }

      audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'agency.driver_authorized', entity_type: 'driver_vehicle',
        entity_id: null, country_id: agency.country_id,
        metadata: { driver_id: driverId, recovery_vehicle_id: vehicleId },
        ip: req.ip, user_agent: req.headers['user-agent'] });

      res.status(201).json({ ok: true, driver_id: driverId, recovery_vehicle_id: vehicleId });
    } catch (e) { next(e); }
  });

  r.delete('/drivers/:driverId/vehicles/:vehicleId', (req, res, next) => {
    try {
      const agency = getAgency(req.user.id);
      if (!agency) return next(Errors.notFound('agency_profile_not_found'));
      const driverId = Number(req.params.driverId);
      const vehicleId = Number(req.params.vehicleId);
      if (!Number.isInteger(driverId) || driverId <= 0) return next(Errors.validation('invalid_driver_id'));
      if (!Number.isInteger(vehicleId) || vehicleId <= 0) return next(Errors.validation('invalid_vehicle_id'));
      const driver = getOwnedDriver(agency.id, driverId);
      if (!driver) return next(Errors.notFound('driver_not_found'));

      const link = db.prepare(
        'SELECT * FROM driver_vehicles WHERE driver_id = ? AND recovery_vehicle_id = ? AND revoked_at IS NULL'
      ).get(driverId, vehicleId);
      if (!link) return next(Errors.notFound('authorization_not_found'));

      db.prepare('UPDATE driver_vehicles SET revoked_at = ? WHERE driver_id = ? AND recovery_vehicle_id = ?')
        .run(new Date().toISOString(), driverId, vehicleId);

      if (driver.current_vehicle_id === vehicleId) {
        db.prepare('UPDATE drivers SET current_vehicle_id = NULL, updated_at = ? WHERE id = ?')
          .run(new Date().toISOString(), driverId);
      }

      audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'agency.driver_authorization_revoked', entity_type: 'driver_vehicle',
        entity_id: null, country_id: agency.country_id,
        metadata: { driver_id: driverId, recovery_vehicle_id: vehicleId },
        ip: req.ip, user_agent: req.headers['user-agent'] });

      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { routes };