const express = require('express');
const { requireRole } = require('../middleware/auth');
const { Errors } = require('../errors');
const { audit } = require('../audit');
const { withTransaction } = require('../db');
const { notify, notifyCountryAdmins, notifyBookingCustomer } = require('../notifications/service');
const config = require('../config');

const CATEGORIES = new Set(['payment', 'conduct', 'damage', 'overcharging', 'late', 'other']);

function routes(db) {
  const r = express.Router();
  r.use(requireRole('driver'));

  function getDriver(userId) {
    return db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(userId);
  }
  function ownBookingOrNull(driverId, bookingId) {
    if (!bookingId) return null;
    const id = Number(bookingId);
    if (!Number.isInteger(id) || id <= 0) return null;
    return db.prepare('SELECT * FROM bookings WHERE id = ? AND driver_id = ?').get(id, driverId);
  }

  r.post('/tickets', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const body = req.body || {};
      const category = String(body.category || '').toLowerCase();
      if (!CATEGORIES.has(category)) return next(Errors.validation('invalid_category'));
      if (!body.subject || typeof body.subject !== 'string' ||
          body.subject.trim().length < 3 || body.subject.trim().length > config.support.ticketSubjectMaxLen) {
        return next(Errors.validation('invalid_subject'));
      }
      if (!body.description || typeof body.description !== 'string' ||
          body.description.trim().length < 5 || body.description.trim().length > config.support.ticketDescriptionMaxLen) {
        return next(Errors.validation('invalid_description'));
      }
      let bookingId = null;
      if (body.booking_id !== undefined && body.booking_id !== null) {
        const b = ownBookingOrNull(driver.id, body.booking_id);
        if (!b) return next(Errors.validation('invalid_booking_id'));
        bookingId = b.id;
      }
      let ticketId;
      withTransaction(db, () => {
        const now = new Date().toISOString();
        const r1 = db.prepare(
          'INSERT INTO support_tickets (country_id, created_by_user_id, created_by_role, booking_id, category, subject, description, status, created_at, updated_at) ' +
          "VALUES (?, ?, 'driver', ?, ?, ?, ?, 'open', ?, ?)"
        ).run(driver.country_id, req.user.id, bookingId, category, body.subject.trim(), body.description.trim(), now, now);
        ticketId = Number(r1.lastInsertRowid);
        notifyCountryAdmins(db, driver.country_id, {
          kind: 'ticket.created',
          title: 'New support ticket #' + ticketId,
          body: body.subject.trim(),
          data: { ticket_id: ticketId, category, created_by_role: 'driver' }
        });
        audit(db, {
          actor_user_id: req.user.id, actor_role: req.user.role,
          action: 'ticket.created', entity_type: 'support_ticket', entity_id: ticketId,
          country_id: driver.country_id, metadata: { category, booking_id: bookingId },
          ip: req.ip, user_agent: req.headers['user-agent']
        });
      });
      const created = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(ticketId);
      res.status(201).json({ ticket: created });
    } catch (e) { next(e); }
  });

  r.get('/tickets', (req, res) => {
    const rows = db.prepare(
      'SELECT id, category, subject, status, booking_id, created_at, updated_at FROM support_tickets ' +
      'WHERE created_by_user_id = ? ORDER BY id DESC LIMIT 100'
    ).all(req.user.id);
    res.json({ tickets: rows });
  });

  r.get('/tickets/:id', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const t = db.prepare('SELECT * FROM support_tickets WHERE id = ? AND created_by_user_id = ?').get(id, req.user.id);
      if (!t) return next(Errors.notFound('ticket_not_found'));
      const messages = db.prepare(
        'SELECT id, sender_user_id, sender_role, body, created_at FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC'
      ).all(t.id);
      res.json({ ticket: t, messages });
    } catch (e) { next(e); }
  });

  r.post('/tickets/:id/messages', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const t = db.prepare('SELECT * FROM support_tickets WHERE id = ? AND created_by_user_id = ?').get(id, req.user.id);
      if (!t) return next(Errors.notFound('ticket_not_found'));
      if (['resolved', 'closed'].includes(t.status)) return next(Errors.conflict('ticket_not_open'));
      const body = req.body || {};
      if (!body.body || typeof body.body !== 'string' ||
          body.body.trim().length < 1 || body.body.trim().length > config.support.ticketMessageMaxLen) {
        return next(Errors.validation('invalid_message_body'));
      }
      let messageId;
      withTransaction(db, () => {
        const now = new Date().toISOString();
        const r1 = db.prepare(
          "INSERT INTO ticket_messages (ticket_id, sender_user_id, sender_role, body) VALUES (?, ?, 'driver', ?)"
        ).run(t.id, req.user.id, body.body.trim());
        messageId = Number(r1.lastInsertRowid);
        db.prepare("UPDATE support_tickets SET status = 'open', updated_at = ? WHERE id = ?").run(now, t.id);
        audit(db, {
          actor_user_id: req.user.id, actor_role: req.user.role,
          action: 'ticket.message', entity_type: 'support_ticket', entity_id: t.id,
          country_id: t.country_id, metadata: { message_id: messageId },
          ip: req.ip, user_agent: req.headers['user-agent']
        });
      });
      const msg = db.prepare('SELECT * FROM ticket_messages WHERE id = ?').get(messageId);
      res.status(201).json({ message: msg });
    } catch (e) { next(e); }
  });

  // notifications
  r.get('/notifications', (req, res) => {
    const unreadOnly = String(req.query.unread || '') === '1';
    const rows = db.prepare(
      'SELECT id, kind, title, body, data_json, read_at, created_at FROM notifications WHERE user_id = ?' +
      (unreadOnly ? ' AND read_at IS NULL' : '') + ' ORDER BY id DESC LIMIT 100'
    ).all(req.user.id);
    res.json({
      notifications: rows.map((n) => ({ ...n, data: n.data_json ? JSON.parse(n.data_json) : null })),
      unread_count: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).n
    });
  });

  r.post('/notifications/:id/read', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const n = db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(id, req.user.id);
      if (!n) return next(Errors.notFound('notification_not_found'));
      if (!n.read_at) db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/notifications/read-all', (req, res) => {
    const now = new Date().toISOString();
    const r1 = db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now, req.user.id);
    res.json({ ok: true, updated: Number(r1.changes) });
  });

  // chat
  r.get('/bookings/:id/chat', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const b = ownBookingOrNull(driver.id, id);
      if (!b) return next(Errors.notFound('booking_not_found'));
      const messages = db.prepare(
        'SELECT id, sender_user_id, sender_role, body, read_at, created_at FROM chat_messages WHERE booking_id = ? ORDER BY id ASC'
      ).all(b.id);
      res.json({ booking_id: b.id, messages });
    } catch (e) { next(e); }
  });

  r.post('/bookings/:id/chat', (req, res, next) => {
    try {
      const driver = getDriver(req.user.id);
      if (!driver) return next(Errors.notFound('driver_profile_not_found'));
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next(Errors.validation('invalid_id'));
      const b = ownBookingOrNull(driver.id, id);
      if (!b) return next(Errors.notFound('booking_not_found'));
      const body = req.body || {};
      if (!body.body || typeof body.body !== 'string' ||
          body.body.trim().length < 1 || body.body.trim().length > config.support.chatMessageMaxLen) {
        return next(Errors.validation('invalid_message_body'));
      }
      let messageId;
      withTransaction(db, () => {
        const r1 = db.prepare(
          "INSERT INTO chat_messages (booking_id, sender_user_id, sender_role, body) VALUES (?, ?, 'driver', ?)"
        ).run(b.id, req.user.id, body.body.trim());
        messageId = Number(r1.lastInsertRowid);
        notifyBookingCustomer(db, b.id, {
          kind: 'chat.message',
          title: 'New chat message from your driver',
          body: body.body.trim().slice(0, 120),
          data: { booking_id: b.id, chat_message_id: messageId }
        });
        audit(db, {
          actor_user_id: req.user.id, actor_role: req.user.role,
          action: 'chat.message_sent', entity_type: 'booking', entity_id: b.id,
          country_id: b.country_id, metadata: { message_id: messageId, sender: 'driver' },
          ip: req.ip, user_agent: req.headers['user-agent']
        });
      });
      const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(messageId);
      res.status(201).json({ message: msg });
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { routes };