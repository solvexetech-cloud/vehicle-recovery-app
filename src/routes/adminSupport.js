const express = require('express');
const { requireRole } = require('../middleware/auth');
const { Errors } = require('../errors');
const { audit } = require('../audit');
const { withTransaction } = require('../db');
const { tryTransition } = require('../booking/tripTransitions');
const { notify } = require('../notifications/service');
const S = require('../payments/service');
const config = require('../config');

const STATUSES = new Set(['open', 'under_review', 'waiting_customer', 'resolved', 'closed']);
const RESOLVE_DISPUTE_TARGETS = new Set(['payment_pending', 'payment_completed', 'cancelled']);

function routes(db) {
  const r = express.Router();
  r.use(requireRole('country_admin', 'super_admin'));

  function isCountryAdmin(req) { return req.user.role === 'country_admin'; }
  function scopeCountry(req) {
    return isCountryAdmin(req) ? req.user.country_id : null;
  }
  function canAccessTicket(req, t) {
    if (!t) return false;
    if (req.user.role === 'super_admin') return true;
    return t.country_id === req.user.country_id;
  }

  // ---- list ----
  r.get('/tickets', (req, res) => {
    const status = String(req.query.status || '').trim();
    const params = [];
    let where = '1=1';
    const sc = scopeCountry(req);
    if (sc) { where += ' AND country_id = ?'; params.push(sc); }
    if (status && STATUSES.has(status)) { where += ' AND status = ?'; params.push(status); }
    const rows = db.prepare(
      'SELECT id, country_id, created_by_user_id, created_by_role, booking_id, category, subject, status, ' +
      'assigned_to_user_id, created_at, updated_at FROM support_tickets WHERE ' + where + ' ORDER BY id DESC LIMIT 200'
    ).all(...params);
    res.json({ tickets: rows });
  });

  r.get('/tickets/:id', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const t = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id);
      if (!canAccessTicket(req, t)) return next(Errors.notFound('ticket_not_found'));
      const messages = db.prepare(
        'SELECT id, sender_user_id, sender_role, body, created_at FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC'
      ).all(t.id);
      res.json({ ticket: t, messages });
    } catch (e) { next(e); }
  });

  r.post('/tickets/:id/assign', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const t = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id);
      if (!canAccessTicket(req, t)) return next(Errors.notFound('ticket_not_found'));
      const body = req.body || {};
      const assignTo = Number(body.assigned_to_user_id);
      if (!Number.isInteger(assignTo) || assignTo <= 0) return next(Errors.validation('invalid_assigned_to_user_id'));
      const target = db.prepare("SELECT id, role, country_id FROM users WHERE id = ? AND role IN ('country_admin','super_admin')").get(assignTo);
      if (!target) return next(Errors.validation('assignee_must_be_admin'));
      if (req.user.role === 'country_admin' && target.role === 'super_admin') {
        return next(Errors.forbidden('cannot_assign_to_super_admin'));
      }
      if (req.user.role === 'country_admin' && target.country_id !== req.user.country_id) {
        return next(Errors.forbidden('cross_country_assign_forbidden'));
      }
      const now = new Date().toISOString();
      db.prepare("UPDATE support_tickets SET assigned_to_user_id = ?, status = CASE WHEN status='open' THEN 'under_review' ELSE status END, updated_at = ? WHERE id = ?")
        .run(assignTo, now, t.id);
      notify(db, { userId: assignTo, kind: 'ticket.assigned', title: 'Ticket #' + t.id + ' assigned to you',
                   body: t.subject, data: { ticket_id: t.id } });
      notify(db, { userId: t.created_by_user_id, kind: 'ticket.updated', title: 'Your ticket #' + t.id + ' is under review',
                   body: t.subject, data: { ticket_id: t.id, status: 'under_review' } });
      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'ticket.assigned', entity_type: 'support_ticket', entity_id: t.id,
        country_id: t.country_id, metadata: { assigned_to_user_id: assignTo },
        ip: req.ip, user_agent: req.headers['user-agent']
      });
      res.json({ ticket: db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(t.id) });
    } catch (e) { next(e); }
  });

  r.post('/tickets/:id/status', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const t = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id);
      if (!canAccessTicket(req, t)) return next(Errors.notFound('ticket_not_found'));
      const body = req.body || {};
      const status = String(body.status || '').trim();
      if (!STATUSES.has(status)) return next(Errors.validation('invalid_status'));
      const now = new Date().toISOString();
      db.prepare('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?').run(status, now, t.id);
      notify(db, { userId: t.created_by_user_id, kind: 'ticket.updated',
                   title: 'Ticket #' + t.id + ' status: ' + status, body: t.subject,
                   data: { ticket_id: t.id, status } });
      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'ticket.status_changed', entity_type: 'support_ticket', entity_id: t.id,
        country_id: t.country_id, metadata: { from: t.status, to: status },
        ip: req.ip, user_agent: req.headers['user-agent']
      });
      res.json({ ticket: db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(t.id) });
    } catch (e) { next(e); }
  });

  r.post('/tickets/:id/resolve', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const t = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id);
      if (!canAccessTicket(req, t)) return next(Errors.notFound('ticket_not_found'));
      const body = req.body || {};
      if (!body.resolution_note || typeof body.resolution_note !== 'string' ||
          body.resolution_note.trim().length < 3 || body.resolution_note.trim().length > config.support.ticketDescriptionMaxLen) {
        return next(Errors.validation('invalid_resolution_note'));
      }
      const now = new Date().toISOString();
      db.prepare("UPDATE support_tickets SET status = 'resolved', resolution_note = ?, resolved_at = ?, updated_at = ? WHERE id = ?")
        .run(body.resolution_note.trim(), now, now, t.id);
      notify(db, { userId: t.created_by_user_id, kind: 'ticket.resolved',
                   title: 'Ticket #' + t.id + ' resolved',
                   body: body.resolution_note.trim().slice(0, 200),
                   data: { ticket_id: t.id } });
      audit(db, {
        actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'ticket.resolved', entity_type: 'support_ticket', entity_id: t.id,
        country_id: t.country_id, metadata: { resolution_note_len: body.resolution_note.length },
        ip: req.ip, user_agent: req.headers['user-agent']
      });
      res.json({ ticket: db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(t.id) });
    } catch (e) { next(e); }
  });

  r.post('/tickets/:id/messages', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const t = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id);
      if (!canAccessTicket(req, t)) return next(Errors.notFound('ticket_not_found'));
      if (['resolved', 'closed'].includes(t.status)) return next(Errors.conflict('ticket_not_open'));
      const body = req.body || {};
      if (!body.body || typeof body.body !== 'string' ||
          body.body.trim().length < 1 || body.body.trim().length > config.support.ticketMessageMaxLen) {
        return next(Errors.validation('invalid_message_body'));
      }
      const role = req.user.role === 'super_admin' ? 'super_admin' : 'country_admin';
      let messageId;
      withTransaction(db, () => {
        const r1 = db.prepare(
          'INSERT INTO ticket_messages (ticket_id, sender_user_id, sender_role, body) VALUES (?, ?, ?, ?)'
        ).run(t.id, req.user.id, role, body.body.trim());
        messageId = Number(r1.lastInsertRowid);
        const now = new Date().toISOString();
        db.prepare("UPDATE support_tickets SET status = 'waiting_customer', updated_at = ? WHERE id = ? AND status IN ('open','under_review')").run(now, t.id);
        notify(db, { userId: t.created_by_user_id, kind: 'ticket.message',
                     title: 'New reply on ticket #' + t.id, body: body.body.trim().slice(0, 120),
                     data: { ticket_id: t.id, message_id: messageId } });
        audit(db, {
          actor_user_id: req.user.id, actor_role: req.user.role,
          action: 'ticket.admin_message', entity_type: 'support_ticket', entity_id: t.id,
          country_id: t.country_id, metadata: { message_id: messageId },
          ip: req.ip, user_agent: req.headers['user-agent']
        });
      });
      res.status(201).json({ message: db.prepare('SELECT * FROM ticket_messages WHERE id = ?').get(messageId) });
    } catch (e) { next(e); }
  });

  // ---- dispute resolution ----
  r.post('/bookings/:id/payment/resolve-dispute', (req, res, next) => {
    try {
      const bookingId = Number(req.params.id);
      if (!Number.isInteger(bookingId) || bookingId <= 0) return next(Errors.validation('invalid_id'));
      const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
      if (!booking) return next(Errors.notFound('booking_not_found'));
      if (isCountryAdmin(req) && booking.country_id !== req.user.country_id) {
        return next(Errors.notFound('booking_not_found'));
      }
      if (booking.status !== 'disputed') return next(Errors.conflict('booking_not_disputed'));
      const body = req.body || {};
      const target = String(body.target_status || '').trim();
      if (!RESOLVE_DISPUTE_TARGETS.has(target)) return next(Errors.validation('invalid_target_status'));
      if (!body.resolution_note || typeof body.resolution_note !== 'string' || body.resolution_note.trim().length < 3) {
        return next(Errors.validation('invalid_resolution_note'));
      }

      let finalBooking;
      withTransaction(db, () => {
        const tr = tryTransition(db, {
          bookingId, from: 'disputed', to: target,
          actorUserId: req.user.id, actorRole: req.user.role,
          reason: body.resolution_note.trim(),
          metadata: { resolved_by_role: req.user.role }
        });
        if (!tr.ok) throw new Error('resolve_failed:' + tr.reason);
        finalBooking = tr.booking;

        const payments = S.listPayments(db, bookingId);
        for (const p of payments) {
          if (p.status === 'disputed') {
            const nextStatus = target === 'payment_completed' ? 'paid' :
                               target === 'cancelled' ? 'failed' : 'pending';
            S.updatePaymentStatus(db, p.id, nextStatus);
            S.recordEvent(db, { paymentId: p.id, eventType: 'dispute_resolved',
                                payload: { target_status: target, note: body.resolution_note.trim() } });
          }
        }

        notify(db, { userId: booking.customer_id, kind: 'dispute.resolved',
                     title: 'Dispute on booking ' + booking.booking_number + ' resolved',
                     body: body.resolution_note.trim().slice(0, 200),
                     data: { booking_id: bookingId, target_status: target } });
        const drv = db.prepare('SELECT user_id FROM drivers WHERE id = ?').get(booking.driver_id || 0);
        if (drv) notify(db, { userId: drv.user_id, kind: 'dispute.resolved',
                              title: 'Dispute on booking ' + booking.booking_number + ' resolved',
                              body: body.resolution_note.trim().slice(0, 200),
                              data: { booking_id: bookingId, target_status: target } });

        audit(db, {
          actor_user_id: req.user.id, actor_role: req.user.role,
          action: 'payment.dispute_resolved', entity_type: 'booking', entity_id: bookingId,
          country_id: booking.country_id, metadata: { target_status: target, note_len: body.resolution_note.length },
          ip: req.ip, user_agent: req.headers['user-agent']
        });
      });
      res.json({ ok: true, booking: { id: finalBooking.id, status: finalBooking.status } });
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { routes };