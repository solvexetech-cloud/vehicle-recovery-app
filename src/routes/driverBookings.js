const express = require('express');
const { requireRole } = require('../middleware/auth');
const { Errors } = require('../errors');
const { audit } = require('../audit');
const { tryAccept, tryReject, getLiveOfferForDriver, advanceDispatch } = require('../booking/dispatch');
const { tryTransition, haversineM, computeCancellationOutcome } = require('../booking/tripTransitions');
const { withTransaction } = require('../db');
const { notifyBookingCustomer } = require('../notifications/service');
const config = require('../config');

const ACTIVE_STATUSES = ['assigned', 'driver_on_way', 'driver_arrived', 'vehicle_loaded', 'trip_in_progress'];

function routes(db) {
  const r = express.Router();
  const guard = requireRole('driver');
  r.use(guard);

  function getDriver(userId) {
    return db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(userId);
  }
  function getOwnBooking(driverId, bookingId) {
    return db.prepare('SELECT * FROM bookings WHERE id = ? AND driver_id = ?').get(bookingId, driverId);
  }

  // ---- Incoming offer ----
  r.get('/incoming', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const live = getLiveOfferForDriver(db, driver.id);
      if (!live) return res.json({ offer: null });
      const b = live.booking;
      res.json({
        offer: {
          id: live.offer.id,
          booking_id: live.offer.booking_id,
          booking_number: b.booking_number,
          expires_at: live.offer.expires_at,
          distance_km: live.offer.distance_km,
          radius_km: live.offer.radius_km,
          offered_at: live.offer.offered_at,
          service_type: b.service_type,
          service_level: b.service_level,
          currency_code: b.currency_code,
          agreed_fare_minor: b.agreed_fare_minor,
          pickup: { lat: b.pickup_lat, lng: b.pickup_lng, address: b.pickup_address },
          destination: { lat: b.destination_lat, lng: b.destination_lng, address: b.destination_address },
          vehicle_snapshot: JSON.parse(b.customer_vehicle_snapshot_json || '{}'),
          breakdown_notes: b.breakdown_notes
        }
      });
    } catch (e) { next(e); }
  });

  // ---- Accept ----
  r.post('/:id/accept', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const bookingId = Number(req.params.id);
      if (!Number.isInteger(bookingId) || bookingId <= 0) return next(Errors.validation('invalid_id'));

      let result;
      withTransaction(db, () => {
        result = tryAccept(db, { bookingId, driverId: driver.id });
        if (result.ok) {
          try {
            notifyBookingCustomer(db, bookingId, {
              kind: 'booking.assigned',
              title: 'Driver assigned to your booking',
              body: result.booking.booking_number,
              data: { booking_id: bookingId }
            });
          } catch (_) { /* non-fatal */ }
          audit(db, {
            actor_user_id: req.user.id, actor_role: req.user.role,
            action: 'dispatch.accepted', entity_type: 'booking', entity_id: bookingId,
            country_id: result.booking.country_id,
            metadata: { driver_id: driver.id, booking_number: result.booking.booking_number },
            ip: req.ip, user_agent: req.headers['user-agent']
          });
        } else {
          audit(db, {
            actor_user_id: req.user.id, actor_role: req.user.role,
            action: 'dispatch.accept_failed', entity_type: 'booking', entity_id: bookingId,
            country_id: driver.country_id,
            metadata: { driver_id: driver.id, reason: result.reason, blockers: result.blockers || null },
            ip: req.ip, user_agent: req.headers['user-agent']
          });
        }
      });

      if (!result.ok) {
        const map = {
          no_active_offer: 409, offer_expired: 409, lost_race: 409,
          booking_not_searching: 409, driver_not_eligible_at_accept: 403,
          no_current_vehicle: 422, booking_not_found: 404
        };
        return res.status(map[result.reason] || 400).json({
          error: result.reason,
          details: result.blockers ? { blockers: result.blockers } : undefined
        });
      }
      res.json({
        ok: true,
        booking: {
          id: result.booking.id,
          booking_number: result.booking.booking_number,
          status: result.booking.status,
          driver_id: result.booking.driver_id,
          recovery_vehicle_id: result.booking.recovery_vehicle_id,
          accepted_at: result.booking.accepted_at
        }
      });
    } catch (e) { next(e); }
  });

  // ---- Reject ----
  r.post('/:id/reject', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const bookingId = Number(req.params.id);
      if (!Number.isInteger(bookingId) || bookingId <= 0) return next(Errors.validation('invalid_id'));

      let result;
      withTransaction(db, () => {
        result = tryReject(db, { bookingId, driverId: driver.id, reason: 'driver_rejected' });
        if (result.ok) {
          const adv = advanceDispatch(db, {
            bookingId, cfg: config, actorUserId: req.user.id, actorRole: req.user.role
          });
          result.advanced = adv;
          audit(db, {
            actor_user_id: req.user.id, actor_role: req.user.role,
            action: 'dispatch.rejected', entity_type: 'booking', entity_id: bookingId,
            country_id: driver.country_id,
            metadata: { driver_id: driver.id, advanced_status: adv.status, next_offer_id: adv.offer ? adv.offer.id : null },
            ip: req.ip, user_agent: req.headers['user-agent']
          });
        }
      });
      if (!result.ok) return next(Errors.conflict(result.reason));
      res.json({
        ok: true,
        advanced: {
          status: result.advanced.status,
          next_offer_id: result.advanced.offer ? result.advanced.offer.id : null,
          next_driver_id: result.advanced.offer ? result.advanced.offer.driver_id : null
        }
      });
    } catch (e) { next(e); }
  });

  // ---- Active booking ----
  r.get('/active', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
      const booking = db.prepare(
        'SELECT * FROM bookings WHERE driver_id = ? AND status IN (' + placeholders + ') ORDER BY id DESC LIMIT 1'
      ).get(driver.id, ...ACTIVE_STATUSES);
      if (!booking) return res.json({ booking: null });
      res.json({
        booking: {
          id: booking.id, booking_number: booking.booking_number, status: booking.status,
          service_type: booking.service_type, service_level: booking.service_level,
          currency_code: booking.currency_code, agreed_fare_minor: booking.agreed_fare_minor,
          pickup: { lat: booking.pickup_lat, lng: booking.pickup_lng, address: booking.pickup_address },
          destination: { lat: booking.destination_lat, lng: booking.destination_lng, address: booking.destination_address },
          vehicle_snapshot: JSON.parse(booking.customer_vehicle_snapshot_json || '{}'),
          breakdown_notes: booking.breakdown_notes,
          created_at: booking.created_at, accepted_at: booking.accepted_at,
          arrived_at: booking.arrived_at, loaded_at: booking.loaded_at, completed_at: booking.completed_at
        }
      });
    } catch (e) { next(e); }
  });

  // ---- Trip transitions ----
  function transitionHandler(to) {
    return (req, res, next) => {
      try {
        const driver = getDriver(req.user.id);
        if (!driver) return next(Errors.notFound('driver_profile_not_found'));
        const bookingId = Number(req.params.id);
        if (!Number.isInteger(bookingId) || bookingId <= 0) return next(Errors.validation('invalid_id'));
        const booking = getOwnBooking(driver.id, bookingId);
        if (!booking) return next(Errors.notFound('booking_not_found'));

        const from = booking.status;
        const body = req.body || {};
        const metadata = {};

        if (to === 'driver_arrived') {
          const d = db.prepare('SELECT last_gps_lat, last_gps_lng, last_gps_at FROM drivers WHERE id = ?').get(driver.id);
          const manual = !!body.manual_fallback;
          const cfg = config.trip;
          let within = false;
          let distanceM = null;
          if (d && d.last_gps_lat !== null && d.last_gps_lng !== null) {
            distanceM = Math.round(haversineM(d.last_gps_lat, d.last_gps_lng, booking.pickup_lat, booking.pickup_lng));
            within = distanceM <= cfg.arrivalGpsThresholdM;
          }
          metadata.gps = { distance_m: distanceM, threshold_m: cfg.arrivalGpsThresholdM, within };

          if (!within) {
            if (!manual) {
              return res.status(409).json({
                error: 'gps_not_near_pickup',
                details: { distance_m: distanceM, threshold_m: cfg.arrivalGpsThresholdM,
                           hint: 'Send { manual_fallback: true, reason } if GPS is inaccurate.' }
              });
            }
            if (!cfg.allowManualArrivalFallback) {
              return next(Errors.forbidden('manual_arrival_fallback_disabled'));
            }
            if (!body.reason || typeof body.reason !== 'string' || body.reason.trim().length < 3) {
              return next(Errors.validation('manual_fallback_reason_required'));
            }
            metadata.manual_fallback = true;
            metadata.manual_reason = body.reason.trim();
          }
        }

        let result;
        withTransaction(db, () => {
          result = tryTransition(db, {
            bookingId, from, to,
            actorUserId: req.user.id, actorRole: 'driver',
            reason: body.reason || null, metadata
          });
          if (result.ok) {
            if (to === 'trip_completed') {
              try {
                notifyBookingCustomer(db, bookingId, {
                  kind: 'booking.trip_completed',
                  title: 'Your trip is complete',
                  body: result.booking.booking_number,
                  data: { booking_id: bookingId }
                });
              } catch (_) { /* non-fatal */ }
            }
            audit(db, {
              actor_user_id: req.user.id, actor_role: req.user.role,
              action: 'trip.' + to, entity_type: 'booking', entity_id: bookingId,
              country_id: booking.country_id, metadata,
              ip: req.ip, user_agent: req.headers['user-agent']
            });
          }
        });

        if (!result.ok) {
          return res.status(409).json({ error: result.reason });
        }
        res.json({ ok: true, booking: {
          id: result.booking.id, booking_number: result.booking.booking_number, status: result.booking.status,
          arrived_at: result.booking.arrived_at, loaded_at: result.booking.loaded_at,
          completed_at: result.booking.completed_at
        }});
      } catch (e) { next(e); }
    };
  }

  r.post('/:id/on-way', transitionHandler('driver_on_way'));
  r.post('/:id/arrived', transitionHandler('driver_arrived'));
  r.post('/:id/loaded', transitionHandler('vehicle_loaded'));
  r.post('/:id/start-trip', transitionHandler('trip_in_progress'));
  r.post('/:id/complete', transitionHandler('trip_completed'));

  // ---- Cancel ----
  r.post('/:id/cancel', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const bookingId = Number(req.params.id);
      if (!Number.isInteger(bookingId) || bookingId <= 0) return next(Errors.validation('invalid_id'));
      const booking = getOwnBooking(driver.id, bookingId);
      if (!booking) return next(Errors.notFound('booking_not_found'));

      const body = req.body || {};
      if (!body.reason || typeof body.reason !== 'string' || body.reason.trim().length < 3) {
        return next(Errors.validation('reason_required'));
      }

      const outcome = computeCancellationOutcome(db, booking, 'driver');
      if (!outcome.allowed) return next(Errors.conflict(outcome.reason));

      let result;
      withTransaction(db, () => {
        result = tryTransition(db, {
          bookingId, from: booking.status, to: 'cancelled',
          actorUserId: req.user.id, actorRole: 'driver',
          reason: body.reason.trim(),
          metadata: { cancelled_by: 'driver', fee_minor: 0 },
          extraColumns: { cancellation_reason: body.reason.trim(), cancellation_fee_minor: 0 }
        });
        if (result.ok) {
          audit(db, {
            actor_user_id: req.user.id, actor_role: req.user.role,
            action: 'booking.cancelled_by_driver', entity_type: 'booking', entity_id: bookingId,
            country_id: booking.country_id,
            metadata: { reason: body.reason.trim() },
            ip: req.ip, user_agent: req.headers['user-agent']
          });
        }
      });
      if (!result.ok) return next(Errors.conflict(result.reason));
      res.json({ ok: true, booking: { id: result.booking.id, status: result.booking.status,
        cancelled_at: result.booking.cancelled_at, cancellation_fee_minor: 0 } });
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { routes };