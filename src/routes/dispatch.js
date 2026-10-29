const express = require('express');
const { requireRole } = require('../middleware/auth');
const { Errors } = require('../errors');
const { audit } = require('../audit');
const { advanceDispatch } = require('../booking/dispatch');
const { withTransaction } = require('../db');
const config = require('../config');

function routes(db) {
  const r = express.Router();
  const guard = requireRole('customer');
  r.use(guard);

  // Start (or advance) dispatch for own booking
  r.post('/:id/dispatch', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(id, req.user.id);
      if (!booking) return next(Errors.notFound('booking_not_found'));
      if (!['created', 'searching'].includes(booking.status)) {
        return next(Errors.conflict('booking_not_dispatchable', { status: booking.status }));
      }

      let result;
      withTransaction(db, () => {
        result = advanceDispatch(db, {
          bookingId: id, cfg: config,
          actorUserId: req.user.id, actorRole: req.user.role
        });
        audit(db, {
          actor_user_id: req.user.id, actor_role: req.user.role,
          action: 'dispatch.started', entity_type: 'booking', entity_id: id,
          country_id: booking.country_id,
          metadata: { result_status: result.status, offer_id: result.offer ? result.offer.id : null },
          ip: req.ip, user_agent: req.headers['user-agent']
        });
      });
      res.json({ ok: true, dispatch: result });
    } catch (e) { next(e); }
  });

  // Advance sweeper — expires stale offers and tries next candidate
  r.post('/:id/dispatch/advance', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(id, req.user.id);
      if (!booking) return next(Errors.notFound('booking_not_found'));

      let result;
      withTransaction(db, () => {
        result = advanceDispatch(db, {
          bookingId: id, cfg: config,
          actorUserId: req.user.id, actorRole: req.user.role
        });
        audit(db, {
          actor_user_id: req.user.id, actor_role: req.user.role,
          action: 'dispatch.advanced', entity_type: 'booking', entity_id: id,
          country_id: booking.country_id,
          metadata: { result_status: result.status, offer_id: result.offer ? result.offer.id : null },
          ip: req.ip, user_agent: req.headers['user-agent']
        });
      });
      res.json({ ok: true, dispatch: result });
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { routes };