const express = require('express');
const { requireRole } = require('../middleware/auth');
const { Errors } = require('../errors');
const { audit } = require('../audit');
const { computeFareEstimate } = require('../booking/fare');
const { hashBody, findKey, storeKey, getStoredResponse } = require('../booking/idempotency');
const { generateBookingNumber } = require('../booking/bookingNumber');
const { recordStatus } = require('../booking/statusHistory');
const { withTransaction } = require('../db');
const { tryTransition, computeCancellationOutcome } = require('../booking/tripTransitions');

const SERVICE_CODES = new Set([
  'towing','accident','flatbed_transport','jump_start','tyre_change','fuel_delivery','lockout','winching'
]);
const SERVICE_LEVELS = new Set(['normal', 'fast']);
const CATEGORIES = new Set([
  'sedan_hatchback','suv','pickup','van','bus','truck','heavy_commercial','motorcycle','three_wheeler'
]);

function isLat(v) { return typeof v === 'number' && isFinite(v) && v >= -90 && v <= 90; }
function isLng(v) { return typeof v === 'number' && isFinite(v) && v >= -180 && v <= 180; }

function validateInput(db, req) {
  const body = req.body || {};
  const serviceCode = String(body.service_type || '').toLowerCase();
  if (!SERVICE_CODES.has(serviceCode)) return { error: 'invalid_service_type' };
  const level = String(body.service_level || 'normal').toLowerCase();
  if (!SERVICE_LEVELS.has(level)) return { error: 'invalid_service_level' };

  if (!body.pickup || !isLat(body.pickup.lat) || !isLng(body.pickup.lng)) return { error: 'invalid_pickup' };
  if (!body.destination || !isLat(body.destination.lat) || !isLng(body.destination.lng)) return { error: 'invalid_destination' };

  // Block any scheduled/advance fields (Immediate only)
  if ('scheduled_at' in body || 'scheduled_time' in body || 'booking_time' in body || 'future_date' in body) {
    return { error: 'scheduled_booking_not_supported' };
  }

  // Vehicle: either saved (vehicle_id) or inline snapshot
  let vehicle = null;
  if (body.vehicle_id !== undefined && body.vehicle_id !== null) {
    const v = db.prepare(
      'SELECT * FROM customer_vehicles WHERE id = ? AND customer_id = ?'
    ).get(Number(body.vehicle_id), req.user.id);
    if (!v) return { error: 'vehicle_not_found' };
    vehicle = {
      source: 'saved',
      id: v.id,
      category: v.category,
      make: v.make,
      model: v.model,
      colour: v.colour,
      registration_number: v.registration_number
    };
  } else if (body.vehicle && typeof body.vehicle === 'object') {
    const v = body.vehicle;
    const cat = String(v.category || '').toLowerCase();
    if (!CATEGORIES.has(cat)) return { error: 'invalid_vehicle_category' };
    if (!v.registration_number || typeof v.registration_number !== 'string' ||
        v.registration_number.trim().length < 1 || v.registration_number.trim().length > 20) {
      return { error: 'invalid_vehicle_registration_number' };
    }
    vehicle = {
      source: 'inline',
      id: null,
      category: cat,
      make: v.make || null,
      model: v.model || null,
      colour: v.colour || null,
      registration_number: v.registration_number.trim()
    };
  } else {
    return { error: 'vehicle_required' };
  }

  // Compute country + settings + service row
  const country = db.prepare('SELECT * FROM countries WHERE id = ?').get(req.user.country_id);
  if (!country) return { error: 'country_not_found' };
  const settings = db.prepare('SELECT * FROM country_settings WHERE country_id = ?').get(country.id);
  if (!settings) return { error: 'country_settings_missing' };
  const serviceRow = db.prepare(
    'SELECT * FROM country_services WHERE country_id = ? AND service_code = ?'
  ).get(country.id, serviceCode);
  if (!serviceRow) return { error: 'service_not_configured' };

  const fare = computeFareEstimate({
    countrySettings: settings,
    serviceRow,
    pickup: body.pickup,
    destination: body.destination,
    serviceLevel: level,
    currencyCode: country.currency_code
  });
  if (fare.error) return { error: fare.error };

  return {
    ok: true,
    country, settings, serviceRow, vehicle, fare,
    pickup: body.pickup,
    destination: body.destination,
    serviceCode,
    serviceLevel: level,
    notes: {
      pickup_address: body.pickup.address || null,
      pickup_notes: body.pickup.notes || null,
      destination_address: body.destination.address || null,
      breakdown_notes: body.breakdown_notes || null
    }
  };
}

function routes(db) {
  const r = express.Router();
  const guard = requireRole('customer');
  r.use(guard);

  // ---- ESTIMATE ----
  r.post('/estimate', (req, res, next) => {
    try {
      const v = validateInput(db, req);
      if (!v.ok) return next(Errors.validation(v.error));
      res.json({
        currency_code: v.country.currency_code,
        service_type: v.serviceCode,
        service_level: v.serviceLevel,
        vehicle_snapshot: v.vehicle,
        fare_breakdown: {
          distance_km: v.fare.distance_km,
          base_fare_minor: v.fare.base_fare_minor,
          distance_fare_minor: v.fare.distance_fare_minor,
          fast_surcharge_minor: v.fare.fast_surcharge_minor,
          min_fare_minor: v.fare.min_fare_minor,
          subtotal_minor: v.fare.subtotal_minor,
          tax_rate_bp: v.fare.tax_rate_bp,
          tax_minor: v.fare.tax_minor,
          total_minor: v.fare.total_minor
        },
        cancellation_policy: v.fare.cancellation_policy,
        note: 'Immediate booking only. No scheduled bookings supported.'
      });
    } catch (e) { next(e); }
  });

  // ---- CREATE ----
  r.post('/', (req, res, next) => {
    try {
      const v = validateInput(db, req);
      if (!v.ok) return next(Errors.validation(v.error));

      // Customer must approve the exact total shown in the estimate
      const body = req.body || {};
      const agreed = Number(body.agreed_fare_minor);
      if (!Number.isInteger(agreed) || agreed <= 0) {
        return next(Errors.validation('agreed_fare_minor_required'));
      }
      if (agreed !== v.fare.total_minor) {
        return next(Errors.validation('agreed_fare_mismatch', {
          agreed_fare_minor: agreed,
          current_estimate_minor: v.fare.total_minor
        }));
      }

      // Idempotency
      const idemKey = req.headers['idempotency-key'];
      const bodyHash = hashBody(body);
      if (idemKey) {
        const existing = findKey(db, 'booking.create', String(idemKey));
        if (existing) {
          const stored = getStoredResponse(existing);
          if (stored.bodyHash === bodyHash && stored.response) {
            return res.status(200).json(stored.response);
          }
          return next(Errors.conflict('idempotency_key_reused_with_different_body'));
        }
      }

      // Create booking atomically
      let createdBooking = null;
      withTransaction(db, () => {
        let bookingNumber = generateBookingNumber();
        // Retry a few times on the very improbable UNIQUE collision
        for (let attempt = 0; attempt < 5; attempt++) {
          const dup = db.prepare('SELECT id FROM bookings WHERE booking_number = ?').get(bookingNumber);
          if (!dup) break;
          bookingNumber = generateBookingNumber();
        }

        const fareJson = JSON.stringify({
          distance_km: v.fare.distance_km,
          base_fare_minor: v.fare.base_fare_minor,
          distance_fare_minor: v.fare.distance_fare_minor,
          fast_surcharge_minor: v.fare.fast_surcharge_minor,
          min_fare_minor: v.fare.min_fare_minor,
          subtotal_minor: v.fare.subtotal_minor,
          tax_rate_bp: v.fare.tax_rate_bp,
          tax_minor: v.fare.tax_minor,
          total_minor: v.fare.total_minor,
          cancellation_policy: v.fare.cancellation_policy
        });

        const vehicleJson = JSON.stringify(v.vehicle);

        const insert = db.prepare(
          'INSERT INTO bookings (' +
          'booking_number, country_id, customer_id, service_type, service_level, ' +
          'customer_vehicle_snapshot_json, pickup_lat, pickup_lng, pickup_address, pickup_notes, ' +
          'destination_lat, destination_lng, destination_address, breakdown_notes, ' +
          'fare_estimate_json, agreed_fare_minor, currency_code, status' +
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created')"
        ).run(
          bookingNumber, v.country.id, req.user.id, v.serviceCode, v.serviceLevel,
          vehicleJson, v.pickup.lat, v.pickup.lng, v.notes.pickup_address, v.notes.pickup_notes,
          v.destination.lat, v.destination.lng, v.notes.destination_address, v.notes.breakdown_notes,
          fareJson, agreed, v.country.currency_code
        );

        const bookingId = Number(insert.lastInsertRowid);

        recordStatus(db, {
          bookingId,
          fromStatus: null,
          toStatus: 'created',
          actorUserId: req.user.id,
          actorRole: req.user.role,
          metadata: { fare_total_minor: agreed, currency_code: v.country.currency_code }
        });

        createdBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);

        audit(db, {
          actor_user_id: req.user.id, actor_role: req.user.role,
          action: 'customer.booking_created', entity_type: 'booking', entity_id: bookingId,
          country_id: v.country.id,
          metadata: { booking_number: bookingNumber, service_type: v.serviceCode, total_minor: agreed },
          ip: req.ip, user_agent: req.headers['user-agent']
        });
      });

      const response = {
        ok: true,
        booking: {
          id: createdBooking.id,
          booking_number: createdBooking.booking_number,
          status: createdBooking.status,
          service_type: createdBooking.service_type,
          service_level: createdBooking.service_level,
          currency_code: createdBooking.currency_code,
          agreed_fare_minor: createdBooking.agreed_fare_minor,
          pickup: { lat: createdBooking.pickup_lat, lng: createdBooking.pickup_lng, address: createdBooking.pickup_address },
          destination: { lat: createdBooking.destination_lat, lng: createdBooking.destination_lng, address: createdBooking.destination_address },
          created_at: createdBooking.created_at
        }
      };

      if (idemKey) storeKey(db, 'booking.create', String(idemKey), bodyHash, response, 'completed');
      res.status(201).json(response);
    } catch (e) { next(e); }
  });

  // ---- LIST own bookings ----
  r.get('/', (req, res, next) => {
    try {
      const rows = db.prepare(
        'SELECT id, booking_number, status, service_type, service_level, currency_code, ' +
        '       agreed_fare_minor, pickup_address, destination_address, created_at ' +
        'FROM bookings WHERE customer_id = ? ORDER BY id DESC LIMIT 100'
      ).all(req.user.id);
      res.json({ bookings: rows });
    } catch (e) { next(e); }
  });

  // ---- READ one ----
  r.get('/:id', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(id, req.user.id);
      if (!b) return next(Errors.notFound('booking_not_found'));
      const history = db.prepare(
        'SELECT id, from_status, to_status, actor_user_id, actor_role, reason, created_at ' +
        'FROM booking_status_history WHERE booking_id = ? ORDER BY id ASC'
      ).all(b.id);
      res.json({
        booking: b,
        fare_breakdown: JSON.parse(b.fare_estimate_json),
        vehicle_snapshot: JSON.parse(b.customer_vehicle_snapshot_json),
        history
      });
    } catch (e) { next(e); }
  });

  // ---- TRACKING (customer view) ----
  r.get('/:id/tracking', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(id, req.user.id);
      if (!b) return next(Errors.notFound('booking_not_found'));

      const driver = b.driver_id
        ? db.prepare('SELECT d.id, d.rating_avg, d.rating_count, d.last_gps_lat, d.last_gps_lng, d.last_gps_at, ' +
                     'u.full_name, u.phone, u.id AS user_id ' +
                     'FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = ?').get(b.driver_id)
        : null;
      const vehicle = b.recovery_vehicle_id
        ? db.prepare('SELECT id, plate_number, vehicle_type, make, model FROM recovery_vehicles WHERE id = ?').get(b.recovery_vehicle_id)
        : null;

      const cs = db.prepare('SELECT contact_privacy_mode, cancellation_fee_minor, free_cancel_seconds FROM country_settings WHERE country_id = ?').get(b.country_id) || {};
      const privacy = cs.contact_privacy_mode || 'show_number';
      const driverOut = driver ? {
        id: driver.id, full_name: driver.full_name,
        phone: privacy === 'show_number' ? driver.phone : null,
        rating_avg: driver.rating_avg, rating_count: driver.rating_count
      } : null;

      const timeline = db.prepare(
        'SELECT from_status, to_status, actor_role, reason, created_at FROM booking_status_history WHERE booking_id = ? ORDER BY id ASC'
      ).all(b.id);

      const live = {};
      if (driver && driver.last_gps_lat !== null && driver.last_gps_lng !== null) {
        const { haversineKm } = require('../booking/fare');
        live.driver_gps = { lat: driver.last_gps_lat, lng: driver.last_gps_lng, at: driver.last_gps_at };
        live.distance_to_pickup_km = Math.round(haversineKm(driver.last_gps_lat, driver.last_gps_lng, b.pickup_lat, b.pickup_lng) * 100) / 100;
        live.distance_to_destination_km = Math.round(haversineKm(driver.last_gps_lat, driver.last_gps_lng, b.destination_lat, b.destination_lng) * 100) / 100;
      }

      res.json({
        booking: {
          id: b.id, booking_number: b.booking_number, status: b.status,
          service_type: b.service_type, service_level: b.service_level,
          currency_code: b.currency_code, agreed_fare_minor: b.agreed_fare_minor,
          pickup: { lat: b.pickup_lat, lng: b.pickup_lng, address: b.pickup_address },
          destination: { lat: b.destination_lat, lng: b.destination_lng, address: b.destination_address },
          created_at: b.created_at, accepted_at: b.accepted_at, arrived_at: b.arrived_at,
          loaded_at: b.loaded_at, completed_at: b.completed_at, cancelled_at: b.cancelled_at
        },
        customer_vehicle_snapshot: JSON.parse(b.customer_vehicle_snapshot_json || '{}'),
        fare_breakdown: JSON.parse(b.fare_estimate_json || '{}'),
        driver: driverOut,
        recovery_vehicle: vehicle,
        live,
        timeline,
        cancellation_policy: { fee_minor: cs.cancellation_fee_minor || 0, free_cancel_seconds: cs.free_cancel_seconds || 0 }
      });
    } catch (e) { next(e); }
  });

  // ---- CANCEL (customer) ----
  r.post('/:id/cancel', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(id, req.user.id);
      if (!b) return next(Errors.notFound('booking_not_found'));

      const body = req.body || {};
      const outcome = computeCancellationOutcome(db, b, 'customer');
      if (!outcome.allowed) return next(Errors.conflict(outcome.reason));

      let result;
      withTransaction(db, () => {
        result = tryTransition(db, {
          bookingId: id, from: b.status, to: 'cancelled',
          actorUserId: req.user.id, actorRole: 'customer',
          reason: body.reason || null,
          metadata: { cancelled_by: 'customer', fee_minor: outcome.fee_minor, policy_reason: outcome.reason },
          extraColumns: {
            cancellation_reason: body.reason || outcome.reason,
            cancellation_fee_minor: outcome.fee_minor
          }
        });
        if (result.ok) {
          audit(db, {
            actor_user_id: req.user.id, actor_role: req.user.role,
            action: 'booking.cancelled_by_customer', entity_type: 'booking', entity_id: id,
            country_id: b.country_id,
            metadata: { fee_minor: outcome.fee_minor, policy_reason: outcome.reason },
            ip: req.ip, user_agent: req.headers['user-agent']
          });
        }
      });
      if (!result.ok) return next(Errors.conflict(result.reason));
      res.json({ ok: true, booking: {
        id: result.booking.id, status: result.booking.status,
        cancelled_at: result.booking.cancelled_at,
        cancellation_fee_minor: result.booking.cancellation_fee_minor
      }});
    } catch (e) { next(e); }
  });

  // ---- INVOICE (customer, for own booking) ----
  r.get('/:id/invoice', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(id, req.user.id);
      if (!b) return next(Errors.notFound('booking_not_found'));
      if (!['payment_completed', 'payment_pending', 'trip_completed', 'disputed'].includes(b.status)) {
        return next(Errors.conflict('invoice_not_available_for_status_' + b.status));
      }
      const country = db.prepare('SELECT * FROM countries WHERE id = ?').get(b.country_id);
      const cs = db.prepare('SELECT * FROM country_settings WHERE country_id = ?').get(b.country_id) || {};
      const customer = db.prepare('SELECT id, full_name, email, phone FROM users WHERE id = ?').get(b.customer_id);
      const driver = b.driver_id
        ? db.prepare('SELECT d.id, u.full_name, u.email FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = ?').get(b.driver_id)
        : null;
      const vehicle = b.recovery_vehicle_id
        ? db.prepare('SELECT id, plate_number, vehicle_type, make, model FROM recovery_vehicles WHERE id = ?').get(b.recovery_vehicle_id)
        : null;
      const fare = JSON.parse(b.fare_estimate_json || '{}');
      const commission_bp = cs.commission_rate_bp || 1500;
      const commission_minor = Math.round((b.agreed_fare_minor * commission_bp) / 10000);
      const payments = db.prepare('SELECT method, status, amount_minor, currency_code FROM payments WHERE booking_id = ?').all(b.id);

      res.json({
        invoice: {
          invoice_number: 'INV-' + b.booking_number.replace('BK-', ''),
          issued_at: new Date().toISOString(),
          booking_number: b.booking_number,
          booking_status: b.status,
          currency_code: b.currency_code,
          company: {
            name: cs.invoice_company_name || 'Vehicle Recovery App',
            address: cs.invoice_company_address || null,
            tax_id: cs.invoice_tax_id || null
          },
          customer: {
            full_name: customer.full_name,
            email: customer.email,
            phone: customer.phone || null
          },
          driver: driver ? { full_name: driver.full_name, email: driver.email } : null,
          recovery_vehicle: vehicle,
          service: {
            type: b.service_type,
            level: b.service_level,
            pickup: { lat: b.pickup_lat, lng: b.pickup_lng, address: b.pickup_address },
            destination: { lat: b.destination_lat, lng: b.destination_lng, address: b.destination_address }
          },
          fare_breakdown: fare,
          amounts: {
            subtotal_minor: fare.subtotal_minor || (b.agreed_fare_minor - (fare.tax_minor || 0)),
            tax_minor: fare.tax_minor || 0,
            total_minor: b.agreed_fare_minor,
            commission_minor,
            commission_rate_bp: commission_bp,
            net_to_driver_minor: b.agreed_fare_minor - commission_minor
          },
          payments,
          generated_by: 'vehicle-recovery-app',
          is_paid: b.status === 'payment_completed',
          country_code: country ? country.code : null
        }
      });
    } catch (e) { next(e); }
  });

  r.get('/:id/invoice', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(id, req.user.id);
      if (!b) return next(Errors.notFound('booking_not_found'));
      if (!['payment_completed', 'payment_pending', 'trip_completed', 'disputed'].includes(b.status)) {
        return next(Errors.conflict('invoice_not_available_for_status_' + b.status));
      }
      const country = db.prepare('SELECT * FROM countries WHERE id = ?').get(b.country_id);
      const cs = db.prepare('SELECT * FROM country_settings WHERE country_id = ?').get(b.country_id) || {};
      const customer = db.prepare('SELECT id, full_name, email, phone FROM users WHERE id = ?').get(b.customer_id);
      const driver = b.driver_id
        ? db.prepare('SELECT d.id, u.full_name, u.email FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = ?').get(b.driver_id)
        : null;
      const vehicle = b.recovery_vehicle_id
        ? db.prepare('SELECT id, plate_number, vehicle_type, make, model FROM recovery_vehicles WHERE id = ?').get(b.recovery_vehicle_id)
        : null;
      const fare = JSON.parse(b.fare_estimate_json || '{}');
      const commission_bp = cs.commission_rate_bp || 1500;
      const commission_minor = Math.round((b.agreed_fare_minor * commission_bp) / 10000);
      const payments = db.prepare('SELECT method, status, amount_minor, currency_code FROM payments WHERE booking_id = ?').all(b.id);
      res.json({
        invoice: {
          invoice_number: 'INV-' + b.booking_number.replace('BK-', ''),
          issued_at: new Date().toISOString(),
          booking_number: b.booking_number, booking_status: b.status, currency_code: b.currency_code,
          company: {
            name: cs.invoice_company_name || 'Vehicle Recovery App',
            address: cs.invoice_company_address || null,
            tax_id: cs.invoice_tax_id || null
          },
          customer: { full_name: customer.full_name, email: customer.email, phone: customer.phone || null },
          driver: driver ? { full_name: driver.full_name, email: driver.email } : null,
          recovery_vehicle: vehicle,
          service: {
            type: b.service_type, level: b.service_level,
            pickup: { lat: b.pickup_lat, lng: b.pickup_lng, address: b.pickup_address },
            destination: { lat: b.destination_lat, lng: b.destination_lng, address: b.destination_address }
          },
          fare_breakdown: fare,
          amounts: {
            subtotal_minor: fare.subtotal_minor || (b.agreed_fare_minor - (fare.tax_minor || 0)),
            tax_minor: fare.tax_minor || 0, total_minor: b.agreed_fare_minor,
            commission_minor, commission_rate_bp: commission_bp,
            net_to_driver_minor: b.agreed_fare_minor - commission_minor
          },
          payments, generated_by: 'vehicle-recovery-app',
          is_paid: b.status === 'payment_completed',
          country_code: country ? country.code : null
        }
      });
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { routes };