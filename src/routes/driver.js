const express = require('express');
const { requireRole } = require('../middleware/auth');
const { Errors } = require('../errors');
const { audit } = require('../audit');
const { evaluateEligibility } = require('../driver/eligibility');
const { saveBase64, deleteFile } = require('../storage');
const config = require('../config');

const DOC_TYPES = new Set(['driving_license','national_id','vehicle_registration','insurance','inspection','operating_permit','other']);
const PHONE_RE = /^[\d+\-\s()]{6,30}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

function isValidName(s) { return typeof s === 'string' && s.trim().length >= 2 && s.trim().length <= 100; }
function isValidPhone(s) { return s === null || s === undefined || s === '' || (typeof s === 'string' && PHONE_RE.test(s)); }
function isValidLat(v) { return typeof v === 'number' && isFinite(v) && v >= -90 && v <= 90; }
function isValidLng(v) { return typeof v === 'number' && isFinite(v) && v >= -180 && v <= 180; }
function isIsoDateish(s) { return typeof s === 'string' && DATE_RE.test(s); }

function routes(db) {
  const r = express.Router();
  const guard = requireRole('driver');
  r.use(guard);

  // ---- helpers ----
  function getDriver(userId) {
    return db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(userId);
  }
  function getAgency(aid) {
    return aid ? db.prepare('SELECT * FROM agencies WHERE id = ?').get(aid) : null;
  }
  function isAuthorizedToDriver(driverId, recoveryVehicleId) {
    return !!db.prepare('SELECT 1 AS ok FROM driver_vehicles WHERE driver_id = ? AND recovery_vehicle_id = ? AND revoked_at IS NULL')
      .get(driverId, recoveryVehicleId);
  }

  // ---- profile ----
  r.get('/profile', (req, res, next) => {
    try {
      const user = db.prepare(
        'SELECT id, country_id, role, full_name, email, phone, status, created_at, last_login_at FROM users WHERE id = ?'
      ).get(req.user.id);
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const agency = getAgency(driver.agency_id);
      const vehicle = driver.current_vehicle_id
        ? db.prepare('SELECT * FROM recovery_vehicles WHERE id = ?').get(driver.current_vehicle_id)
        : null;
      const elig = evaluateEligibility(db, driver.id);
      res.json({
        profile: user,
        driver: {
          id: driver.id, status: driver.status, agency_id: driver.agency_id,
          current_vehicle_id: driver.current_vehicle_id,
          is_online: !!driver.is_online,
          last_gps: driver.last_gps_at
            ? { lat: driver.last_gps_lat, lng: driver.last_gps_lng, at: driver.last_gps_at }
            : null,
          rating_avg: driver.rating_avg, rating_count: driver.rating_count
        },
        agency: agency ? { id: agency.id, display_name: agency.display_name, status: agency.status } : null,
        vehicle,
        eligibility: elig
      });
    } catch (e) { next(e); }
  });

  r.patch('/profile', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));

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

      audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'driver.profile_updated', entity_type: 'user', entity_id: req.user.id,
        country_id: req.user.country_id, metadata: { fields: Object.keys(updates) },
        ip: req.ip, user_agent: req.headers['user-agent'] });

      const updated = db.prepare(
        'SELECT id, country_id, role, full_name, email, phone, status FROM users WHERE id = ?'
      ).get(req.user.id);
      res.json({ profile: updated });
    } catch (e) { next(e); }
  });

  // ---- vehicles authorized for this driver ----
  r.get('/vehicles', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const rows = db.prepare(
        'SELECT rv.* FROM driver_vehicles dv JOIN recovery_vehicles rv ON rv.id = dv.recovery_vehicle_id ' +
        'WHERE dv.driver_id = ? AND dv.revoked_at IS NULL ORDER BY rv.id'
      ).all(driver.id);
      res.json({ vehicles: rows });
    } catch (e) { next(e); }
  });

  r.post('/current-vehicle', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const body = req.body || {};
      const vid = Number(body.recovery_vehicle_id);
      if (!Number.isInteger(vid) || vid <= 0) return next(Errors.validation('invalid_recovery_vehicle_id'));

      const v = db.prepare('SELECT * FROM recovery_vehicles WHERE id = ?').get(vid);
      if (!v) return next(Errors.notFound('vehicle_not_found'));
      if (driver.agency_id && v.agency_id && v.agency_id !== driver.agency_id) {
        return next(Errors.forbidden('vehicle_not_from_your_agency'));
      }
      if (!isAuthorizedToDriver(driver.id, vid)) {
        return next(Errors.forbidden('vehicle_not_authorized_for_driver'));
      }
      if (v.status !== 'approved') return next(Errors.forbidden('vehicle_not_approved'));

      db.prepare('UPDATE drivers SET current_vehicle_id = ?, updated_at = ? WHERE id = ?')
        .run(vid, new Date().toISOString(), driver.id);

      audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'driver.vehicle_selected', entity_type: 'driver', entity_id: driver.id,
        country_id: driver.country_id, metadata: { recovery_vehicle_id: vid },
        ip: req.ip, user_agent: req.headers['user-agent'] });

      res.json({ current_vehicle_id: vid });
    } catch (e) { next(e); }
  });

  // ---- online status ----
  r.post('/status', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const body = req.body || {};
      if (typeof body.is_online !== 'boolean') return next(Errors.validation('invalid_is_online'));

      if (body.is_online) {
        const elig = evaluateEligibility(db, driver.id);
        if (!elig.eligible) {
          // Online requires GPS + approved + vehicle + documents; user_offline is not a reason here
          const blocking = elig.reasons.filter((x) => x !== 'driver_offline');
          if (blocking.length > 0) {
            return next(Errors.forbidden('not_eligible_online:' + blocking.join(',')));
          }
        }
      }

      db.prepare('UPDATE drivers SET is_online = ?, updated_at = ? WHERE id = ?')
        .run(body.is_online ? 1 : 0, new Date().toISOString(), driver.id);

      audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'driver.status_changed', entity_type: 'driver', entity_id: driver.id,
        country_id: driver.country_id, metadata: { is_online: body.is_online },
        ip: req.ip, user_agent: req.headers['user-agent'] });

      res.json({ is_online: body.is_online });
    } catch (e) { next(e); }
  });

  // ---- GPS ----
  r.post('/location', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const body = req.body || {};
      if (!isValidLat(body.lat)) return next(Errors.validation('invalid_lat'));
      if (!isValidLng(body.lng)) return next(Errors.validation('invalid_lng'));

      const now = new Date().toISOString();
      db.prepare('UPDATE drivers SET last_gps_lat = ?, last_gps_lng = ?, last_gps_at = ?, updated_at = ? WHERE id = ?')
        .run(body.lat, body.lng, now, now, driver.id);

      res.json({ ok: true, lat: body.lat, lng: body.lng, at: now });
    } catch (e) { next(e); }
  });

  // ---- documents ----
  r.get('/documents', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const rows = db.prepare(
        'SELECT id, doc_type, mime_type, size_bytes, expires_at, review_status, rejection_reason, uploaded_at ' +
        'FROM driver_documents WHERE driver_id = ? ORDER BY id ASC'
      ).all(driver.id);
      res.json({ documents: rows });
    } catch (e) { next(e); }
  });

  r.post('/documents', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const body = req.body || {};
      const docType = String(body.doc_type || '').toLowerCase();
      if (!DOC_TYPES.has(docType)) return next(Errors.validation('invalid_doc_type'));
      const dataUrl = body.data_url;
      let expiresAt = null;
      if ('expires_at' in body && body.expires_at !== null && body.expires_at !== '') {
        if (!isIsoDateish(body.expires_at)) return next(Errors.validation('invalid_expires_at'));
        expiresAt = body.expires_at;
      }

      const saved = saveBase64({
        uploadsDir: config.uploadsDir,
        subdir: 'driver_' + driver.id,
        dataUrl,
        maxBytes: config.driverDocMaxBytes
      });
      if (!saved.ok) return next(Errors.validation(saved.error, { mime: saved.mime, size: saved.size }));

      const now = new Date().toISOString();
      const r1 = db.prepare(
        'INSERT INTO driver_documents (driver_id, doc_type, file_path, mime_type, size_bytes, expires_at, review_status, uploaded_at, updated_at) ' +
        "VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)"
      ).run(driver.id, docType, saved.relativePath, saved.mime, saved.size, expiresAt, now, now);

      audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'driver.document_uploaded', entity_type: 'driver_document',
        entity_id: Number(r1.lastInsertRowid), country_id: driver.country_id,
        metadata: { doc_type: docType, size: saved.size, mime: saved.mime },
        ip: req.ip, user_agent: req.headers['user-agent'] });

      const created = db.prepare(
        'SELECT id, doc_type, mime_type, size_bytes, expires_at, review_status, uploaded_at FROM driver_documents WHERE id = ?'
      ).get(r1.lastInsertRowid);
      res.status(201).json({ document: created });
    } catch (e) { next(e); }
  });

  r.delete('/documents/:id', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const doc = db.prepare('SELECT * FROM driver_documents WHERE id = ? AND driver_id = ?').get(id, driver.id);
      if (!doc) return next(Errors.notFound('document_not_found'));

      deleteFile({ uploadsDir: config.uploadsDir, relativePath: doc.file_path });
      db.prepare('DELETE FROM driver_documents WHERE id = ?').run(id);

      audit(db, { actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'driver.document_deleted', entity_type: 'driver_document', entity_id: id,
        country_id: driver.country_id,
        ip: req.ip, user_agent: req.headers['user-agent'] });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---- eligibility ----
  r.get('/eligibility', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const elig = evaluateEligibility(db, driver.id);
      res.json(elig);
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { routes };