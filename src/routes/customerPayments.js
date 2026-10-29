const express = require('express');
const crypto = require('node:crypto');
const { requireRole } = require('../middleware/auth');
const { Errors } = require('../errors');
const { audit } = require('../audit');
const { withTransaction } = require('../db');
const { notifyBookingDriver, notifyCountryAdmins } = require('../notifications/service');
const { tryTransition } = require('../booking/tripTransitions');
const { hashBody, findKey, storeKey, getStoredResponse } = require('../booking/idempotency');
const S = require('../payments/service');
const config = require('../config');

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
  const guard = requireRole('customer');
  r.use(guard);

  function ownBooking(req) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return { error: 'invalid_id' };
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(id, req.user.id);
    if (!b) return { error: 'booking_not_found' };
    return { booking: b };
  }
  function idemScope(kind, bookingId) { return 'payment.' + kind + ':' + bookingId; }

  // GET payment status
  r.get('/:id/payment', (req, res, next) => {
    try {
      const own = ownBooking(req);
      if (own.error === 'booking_not_found') return next(Errors.notFound('booking_not_found'));
      if (own.error) return next(Errors.validation(own.error));
      const payments = S.listPayments(db, own.booking.id);
      const events = payments.flatMap((p) => S.listEvents(db, p.id));
      res.json({
        booking_id: own.booking.id,
        booking_status: own.booking.status,
        agreed_fare_minor: own.booking.agreed_fare_minor,
        currency_code: own.booking.currency_code,
        payment_status: S.summarizeStatus(payments),
        payments, events
      });
    } catch (e) { next(e); }
  });

  // Customer confirms cash paid
  r.post('/:id/payment/cash-paid', (req, res, next) => {
    try {
      const own = ownBooking(req);
      if (own.error === 'booking_not_found') return next(Errors.notFound('booking_not_found'));
      if (own.error) return next(Errors.validation(own.error));
      const booking = own.booking;

      const amt = parseAmount(req, booking);
      if (amt.error) return next(Errors.conflict(amt.error, amt.details));

      // IDEMPOTENCY MUST RUN BEFORE STATE GUARDS
      const idemKey = req.headers['idempotency-key'];
      const scope = idemScope('cash_paid', booking.id);
      const bodyHash = hashBody(req.body || {});
      if (idemKey) {
        const existing = findKey(db, scope, String(idemKey));
        if (existing) {
          const stored = getStoredResponse(existing);
          if (stored.bodyHash === bodyHash && stored.response) return res.status(200).json(stored.response);
          return next(Errors.conflict('idempotency_key_reused_with_different_body'));
        }
      }

      // THEN state guards
      if (booking.status === 'payment_completed') return next(Errors.conflict('already_paid'));
      if (!S.PAYABLE_FROM.has(booking.status)) return next(Errors.conflict('not_payable_from_' + booking.status));

      let finalBooking, paymentRow, b = booking;
      withTransaction(db, () => {
        if (b.status === 'trip_completed') {
          const tr = tryTransition(db, {
            bookingId: b.id, from: 'trip_completed', to: 'payment_pending',
            actorUserId: req.user.id, actorRole: 'customer', reason: 'cash_payment_started'
          });
          if (!tr.ok) throw new Error('payment_pending_failed:' + tr.reason);
          b = tr.booking;
        }

        const existing = S.findPaymentByMethod(db, b.id, 'cash');
        if (existing) {
          paymentRow = S.updatePaymentStatus(db, existing.id, 'paid');
          S.recordEvent(db, { paymentId: paymentRow.id, eventType: 'cash_paid', amountMinor: amt.amount });
        } else {
          paymentRow = S.createPayment(db, { booking: b, method: 'cash', status: 'paid',
                                             idempotencyKey: idemKey ? String(idemKey) : null });
          S.recordEvent(db, { paymentId: paymentRow.id, eventType: 'cash_paid', amountMinor: amt.amount });
        }

        const fr = tryTransition(db, {
          bookingId: b.id, from: 'payment_pending', to: 'payment_completed',
          actorUserId: req.user.id, actorRole: 'customer', reason: 'cash_payment_confirmed',
          metadata: { amount_minor: amt.amount, payment_id: paymentRow.id }
        });
        if (!fr.ok) throw new Error('payment_completed_failed:' + fr.reason);
        finalBooking = fr.booking;

        notifyBookingDriver(db, b.id, {
          kind: 'payment.cash_paid',
          title: 'Customer confirmed cash payment',
          body: b.booking_number,
          data: { booking_id: b.id, amount_minor: amt.amount }
        });
        audit(db, {
          actor_user_id: req.user.id, actor_role: req.user.role,
          action: 'payment.cash_paid', entity_type: 'booking', entity_id: b.id,
          country_id: b.country_id, metadata: { amount_minor: amt.amount, payment_id: paymentRow.id },
          ip: req.ip, user_agent: req.headers['user-agent']
        });
      });

      const response = {
        ok: true,
        booking: { id: finalBooking.id, status: finalBooking.status },
        payment: { id: paymentRow.id, method: paymentRow.method, status: paymentRow.status, amount_minor: paymentRow.amount_minor }
      };
      if (idemKey) storeKey(db, scope, String(idemKey), bodyHash, response, 'completed');
      res.status(201).json(response);
    } catch (e) { next(e); }
  });

  // Online test initiate
  r.post('/:id/payment/online/test', (req, res, next) => {
    try {
      if (config.nodeEnv === 'production') return next(Errors.forbidden('test_online_not_allowed_in_production'));
      const own = ownBooking(req);
      if (own.error === 'booking_not_found') return next(Errors.notFound('booking_not_found'));
      if (own.error) return next(Errors.validation(own.error));
      const booking = own.booking;

      if (booking.status === 'payment_completed') return next(Errors.conflict('already_paid'));
      if (!S.PAYABLE_FROM.has(booking.status)) return next(Errors.conflict('not_payable_from_' + booking.status));

      const amt = parseAmount(req, booking);
      if (amt.error) return next(Errors.conflict(amt.error, amt.details));

      const idemKey = req.headers['idempotency-key'];
      const scope = idemScope('online_test', booking.id);
      const bodyHash = hashBody(req.body || {});
      if (idemKey) {
        const existing = findKey(db, scope, String(idemKey));
        if (existing) {
          const stored = getStoredResponse(existing);
          if (stored.bodyHash === bodyHash && stored.response) return res.status(200).json(stored.response);
          return next(Errors.conflict('idempotency_key_reused_with_different_body'));
        }
      }

      let paymentRow, b = booking;
      withTransaction(db, () => {
        if (b.status === 'trip_completed') {
          const tr = tryTransition(db, {
            bookingId: b.id, from: 'trip_completed', to: 'payment_pending',
            actorUserId: req.user.id, actorRole: 'customer', reason: 'online_payment_started'
          });
          if (!tr.ok) throw new Error('payment_pending_failed:' + tr.reason);
          b = tr.booking;
        }

        const existing = S.findPaymentByMethod(db, b.id, 'test');
        if (existing) {
          paymentRow = existing;
        } else {
          const providerRef = 'TEST-' + crypto.randomBytes(6).toString('hex').toUpperCase();
          paymentRow = S.createPayment(db, {
            booking: b, method: 'test', status: 'authorized', provider: 'test', providerRef,
            idempotencyKey: idemKey ? String(idemKey) : null
          });
          S.recordEvent(db, { paymentId: paymentRow.id, eventType: 'online_test_authorized',
                              amountMinor: amt.amount, payload: { provider_ref: providerRef } });
        }

        audit(db, {
          actor_user_id: req.user.id, actor_role: req.user.role,
          action: 'payment.online_test_initiated', entity_type: 'booking', entity_id: b.id,
          country_id: b.country_id, metadata: { amount_minor: amt.amount, payment_id: paymentRow.id },
          ip: req.ip, user_agent: req.headers['user-agent']
        });
      });

      const response = {
        ok: true, is_test: true,
        booking: { id: b.id, status: b.status },
        payment: { id: paymentRow.id, method: 'test', status: paymentRow.status,
                   amount_minor: paymentRow.amount_minor, provider_ref: paymentRow.provider_ref },
        next: 'POST /api/customer/bookings/' + b.id + '/payment/online/test/confirm'
      };
      if (idemKey) storeKey(db, scope, String(idemKey), bodyHash, response, 'completed');
      res.status(201).json(response);
    } catch (e) { next(e); }
  });

  // Online test confirm
  r.post('/:id/payment/online/test/confirm', (req, res, next) => {
    try {
      if (config.nodeEnv === 'production') return next(Errors.forbidden('test_online_not_allowed_in_production'));
      const own = ownBooking(req);
      if (own.error === 'booking_not_found') return next(Errors.notFound('booking_not_found'));
      if (own.error) return next(Errors.validation(own.error));
      const booking = own.booking;

      if (booking.status !== 'payment_pending') return next(Errors.conflict('not_in_payment_pending_' + booking.status));
      const existing = S.findPaymentByMethod(db, booking.id, 'test');
      if (!existing) return next(Errors.conflict('no_authorized_test_payment'));
      if (existing.status !== 'authorized') return next(Errors.conflict('payment_not_authorized_state_' + existing.status));

      let paymentRow, finalBooking;
      withTransaction(db, () => {
        paymentRow = S.updatePaymentStatus(db, existing.id, 'paid');
        S.recordEvent(db, { paymentId: paymentRow.id, eventType: 'online_test_confirmed', amountMinor: paymentRow.amount_minor });

        const fr = tryTransition(db, {
          bookingId: booking.id, from: 'payment_pending', to: 'payment_completed',
          actorUserId: req.user.id, actorRole: 'customer', reason: 'online_test_payment_confirmed',
          metadata: { amount_minor: paymentRow.amount_minor, payment_id: paymentRow.id }
        });
        if (!fr.ok) throw new Error('payment_completed_failed:' + fr.reason);
        finalBooking = fr.booking;

        notifyBookingDriver(db, booking.id, {
          kind: 'payment.online_paid',
          title: 'Customer paid online (test mode)',
          body: booking.booking_number,
          data: { booking_id: booking.id, amount_minor: paymentRow.amount_minor }
        });
        audit(db, {
          actor_user_id: req.user.id, actor_role: req.user.role,
          action: 'payment.online_test_confirmed', entity_type: 'booking', entity_id: booking.id,
          country_id: booking.country_id, metadata: { payment_id: paymentRow.id },
          ip: req.ip, user_agent: req.headers['user-agent']
        });
      });
      res.json({
        ok: true,
        booking: { id: finalBooking.id, status: finalBooking.status },
        payment: { id: paymentRow.id, method: 'test', status: paymentRow.status, amount_minor: paymentRow.amount_minor }
      });
    } catch (e) { next(e); }
  });

  // Dispute
  r.post('/:id/payment/dispute', (req, res, next) => {
    try {
      const own = ownBooking(req);
      if (own.error === 'booking_not_found') return next(Errors.notFound('booking_not_found'));
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
            actorUserId: req.user.id, actorRole: 'customer', reason: 'dispute_opens_payment'
          });
          if (!tr.ok) throw new Error('pending_failed:' + tr.reason);
          from = 'payment_pending';
        }
        const r2 = tryTransition(db, {
          bookingId: booking.id, from, to: 'disputed',
          actorUserId: req.user.id, actorRole: 'customer', reason: body.reason.trim(),
          metadata: { disputed_by: 'customer' }
        });
        if (!r2.ok) throw new Error('dispute_failed:' + r2.reason);
        finalBooking = r2.booking;

        const payments = S.listPayments(db, booking.id);
        for (const p of payments) {
          if (p.status !== 'disputed') {
            S.updatePaymentStatus(db, p.id, 'disputed');
            S.recordEvent(db, { paymentId: p.id, eventType: 'dispute_opened',
                                payload: { reason: body.reason.trim(), by: 'customer' } });
          }
        }

        notifyBookingDriver(db, booking.id, {
          kind: 'dispute.opened',
          title: 'Customer opened a dispute on ' + booking.booking_number,
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