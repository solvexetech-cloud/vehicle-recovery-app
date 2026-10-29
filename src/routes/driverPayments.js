const express = require('express');
const { requireRole } = require('../middleware/auth');
const { Errors } = require('../errors');
const { audit } = require('../audit');
const { withTransaction } = require('../db');
const { notifyBookingCustomer, notifyCountryAdmins } = require('../notifications/service');
const { tryTransition } = require('../booking/tripTransitions');
const S = require('../payments/service');

function parseAmount(req, booking) {
  const body = req.body || {};
  if (body.amount_minor !== undefined && body.amount_minor !== null) {
    if (!Number.isInteger(body.amount_minor) || body.amount_minor <= 0) return { error: 'invalid_amount_minor' };
    if (body.amount_minor !== booking.agreed_fare_minor) {
      return { error: 'amount_mismatch', details: { expected_minor: booking.agreed_fare_minor, provided_minor: body.amount_minor } };
    }
    return { amount: body.amount_minor };
  }
  return { amount: booking.agreed_fare_minor };
}

function routes(db) {
  const r = express.Router();
  const guard = requireRole('driver');
  r.use(guard);

  function ownBooking(req) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return { error: 'invalid_id' };
    const driver = db.prepare('SELECT id FROM drivers WHERE user_id = ?').get(req.user.id);
    if (!driver) return { error: 'driver_profile_not_found' };
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND driver_id = ?').get(id, driver.id);
    if (!b) return { error: 'booking_not_found' };
    return { booking: b, driver };
  }

  // Driver records cash received
  r.post('/:id/payment/cash-received', (req, res, next) => {
    try {
      const own = ownBooking(req);
      if (own.error === 'driver_profile_not_found' || own.error === 'booking_not_found') {
        return next(Errors.notFound(own.error));
      }
      if (own.error) return next(Errors.validation(own.error));
      const booking = own.booking;

      if (booking.status === 'payment_completed') {
        let paymentRow = S.findPaymentByMethod(db, booking.id, 'cash');
        if (!paymentRow) return next(Errors.conflict('no_cash_payment_record'));
        S.recordEvent(db, { paymentId: paymentRow.id, eventType: 'cash_received_by_driver_late',
                            amountMinor: booking.agreed_fare_minor });
        return res.json({ ok: true, note: 'recorded_late',
                          payment: { id: paymentRow.id, status: paymentRow.status } });
      }

      if (!S.PAYABLE_FROM.has(booking.status)) return next(Errors.conflict('not_payable_from_' + booking.status));

      const amt = parseAmount(req, booking);
      if (amt.error) return next(Errors.conflict(amt.error, amt.details));

      let b = booking, paymentRow;
      withTransaction(db, () => {
        if (b.status === 'trip_completed') {
          const tr = tryTransition(db, {
            bookingId: b.id, from: 'trip_completed', to: 'payment_pending',
            actorUserId: req.user.id, actorRole: 'driver', reason: 'cash_handed_over'
          });
          if (!tr.ok) throw new Error('payment_pending_failed:' + tr.reason);
          b = tr.booking;
        }

        const existing = S.findPaymentByMethod(db, b.id, 'cash');
        if (existing) {
          paymentRow = existing;
          S.recordEvent(db, { paymentId: paymentRow.id, eventType: 'cash_received_by_driver', amountMinor: amt.amount });
        } else {
          paymentRow = S.createPayment(db, { booking: b, method: 'cash', status: 'pending' });
          S.recordEvent(db, { paymentId: paymentRow.id, eventType: 'cash_received_by_driver', amountMinor: amt.amount });
        }

        notifyBookingCustomer(db, b.id, {
          kind: 'payment.cash_received',
          title: 'Driver recorded cash payment receipt',
          body: b.booking_number,
          data: { booking_id: b.id, amount_minor: amt.amount }
        });
        audit(db, {
          actor_user_id: req.user.id, actor_role: req.user.role,
          action: 'payment.cash_received_by_driver', entity_type: 'booking', entity_id: b.id,
          country_id: b.country_id, metadata: { amount_minor: amt.amount, payment_id: paymentRow.id },
          ip: req.ip, user_agent: req.headers['user-agent']
        });
      });

      res.status(201).json({
        ok: true,
        booking: { id: b.id, status: b.status },
        payment: { id: paymentRow.id, method: paymentRow.method, status: paymentRow.status, amount_minor: paymentRow.amount_minor }
      });
    } catch (e) { next(e); }
  });

  // Driver disputes payment
  r.post('/:id/payment/dispute', (req, res, next) => {
    try {
      const own = ownBooking(req);
      if (own.error === 'driver_profile_not_found' || own.error === 'booking_not_found') {
        return next(Errors.notFound(own.error));
      }
      if (own.error) return next(Errors.validation(own.error));
      const booking = own.booking;

      const body = req.body || {};
      if (!body.reason || typeof body.reason !== 'string' || body.reason.trim().length < 3) {
        return next(Errors.validation('reason_required'));
      }
      if (!S.DISPUTABLE_FROM.has(booking.status)) return next(Errors.conflict('not_disputable_from_' + booking.status));

      let finalBooking;
      withTransaction(db, () => {
        let from = booking.status;
        if (from === 'trip_completed') {
          const tr = tryTransition(db, {
            bookingId: booking.id, from, to: 'payment_pending',
            actorUserId: req.user.id, actorRole: 'driver', reason: 'dispute_opens_payment'
          });
          if (!tr.ok) throw new Error('pending_failed:' + tr.reason);
          from = 'payment_pending';
        }
        const r2 = tryTransition(db, {
          bookingId: booking.id, from, to: 'disputed',
          actorUserId: req.user.id, actorRole: 'driver', reason: body.reason.trim(),
          metadata: { disputed_by: 'driver' }
        });
        if (!r2.ok) throw new Error('dispute_failed:' + r2.reason);
        finalBooking = r2.booking;

        const payments = S.listPayments(db, booking.id);
        for (const p of payments) {
          if (p.status !== 'disputed') {
            S.updatePaymentStatus(db, p.id, 'disputed');
            S.recordEvent(db, { paymentId: p.id, eventType: 'dispute_opened',
                                payload: { reason: body.reason.trim(), by: 'driver' } });
          }
        }

        notifyBookingCustomer(db, booking.id, {
          kind: 'dispute.opened',
          title: 'Driver opened a dispute on ' + booking.booking_number,
          body: body.reason.trim().slice(0, 200),
          data: { booking_id: booking.id }
        });
        notifyCountryAdmins(db, booking.country_id, {
          kind: 'dispute.opened',
          title: 'Dispute opened on booking ' + booking.booking_number,
          body: body.reason.trim().slice(0, 200),
          data: { booking_id: booking.id }
        });
        audit(db, {
          actor_user_id: req.user.id, actor_role: req.user.role,
          action: 'payment.dispute_opened', entity_type: 'booking', entity_id: booking.id,
          country_id: booking.country_id, metadata: { reason: body.reason.trim() },
          ip: req.ip, user_agent: req.headers['user-agent']
        });
      });
      res.json({ ok: true, booking: { id: finalBooking.id, status: finalBooking.status } });
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { routes };