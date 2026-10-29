const { recordStatus } = require('./statusHistory');

const ALLOWED_TRANSITIONS = {
  'assigned':        ['driver_on_way', 'cancelled'],
  'driver_on_way':   ['driver_arrived', 'cancelled'],
  'driver_arrived':  ['vehicle_loaded', 'cancelled'],
  'vehicle_loaded':  ['trip_in_progress', 'cancelled'],
  'trip_in_progress':['trip_completed'],
  'trip_completed':  ['payment_pending', 'disputed'],
  'payment_pending': ['payment_completed', 'payment_failed', 'disputed'],
  'payment_completed': ['disputed'],
  'payment_failed': ['payment_pending', 'disputed'],
  'disputed': ['payment_pending', 'payment_completed', 'cancelled']
};

const TIMESTAMP_FIELDS = {
  'driver_arrived': 'arrived_at',
  'vehicle_loaded': 'loaded_at',
  'trip_completed': 'completed_at',
  'cancelled': 'cancelled_at'
};

function isTransitionAllowed(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

/**
 * Atomic transition. Only succeeds if the booking's current status equals `from`.
 * Records a booking_status_history row inside the same statement sequence.
 *
 * Returns { ok: true, booking } or { ok: false, reason }.
 */
function tryTransition(db, { bookingId, from, to, actorUserId, actorRole, reason, metadata, extraColumns = {} }) {
  if (!isTransitionAllowed(from, to)) return { ok: false, reason: 'invalid_status_transition' };
  const now = new Date().toISOString();

  const setClauses = ['status = ?', 'updated_at = ?'];
  const values = [to, now];

  if (TIMESTAMP_FIELDS[to]) {
    setClauses.push(TIMESTAMP_FIELDS[to] + ' = ?');
    values.push(now);
  }
  for (const [k, v] of Object.entries(extraColumns)) {
    setClauses.push(k + ' = ?');
    values.push(v);
  }
  values.push(bookingId, from);

  const upd = db.prepare(
    'UPDATE bookings SET ' + setClauses.join(', ') + ' WHERE id = ? AND status = ?'
  ).run(...values);

  if (upd.changes !== 1) return { ok: false, reason: 'invalid_status_transition' };

  recordStatus(db, {
    bookingId, fromStatus: from, toStatus: to,
    actorUserId, actorRole, reason, metadata
  });

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  return { ok: true, booking };
}

function haversineM(lat1, lng1, lat2, lng2) {
  const { haversineKm } = require('./fare');
  return haversineKm(lat1, lng1, lat2, lng2) * 1000;
}

/**
 * Compute the cancellation outcome for the actor.
 * Returns { allowed, fee_minor, reason, blocked_reason? }
 */
function computeCancellationOutcome(db, booking, actorRole, now = new Date()) {
  const cs = db.prepare(
    'SELECT cancellation_fee_minor, free_cancel_seconds FROM country_settings WHERE country_id = ?'
  ).get(booking.country_id) || { cancellation_fee_minor: 0, free_cancel_seconds: 300 };

  if (actorRole === 'driver') {
    if (!['assigned', 'driver_on_way'].includes(booking.status)) {
      return { allowed: false, fee_minor: 0, reason: 'not_cancellable_by_driver_from_' + booking.status };
    }
    return { allowed: true, fee_minor: 0, reason: 'driver_initiated' };
  }

  // Customer
  if (['created', 'searching'].includes(booking.status)) {
    return { allowed: true, fee_minor: 0, reason: 'before_driver_assigned' };
  }
  if (['assigned', 'driver_on_way', 'driver_arrived'].includes(booking.status)) {
    const elapsedSec = (now.getTime() - new Date(booking.created_at).getTime()) / 1000;
    if (elapsedSec <= cs.free_cancel_seconds) {
      return { allowed: true, fee_minor: 0, reason: 'within_free_window' };
    }
    return { allowed: true, fee_minor: cs.cancellation_fee_minor, reason: 'after_free_window' };
  }
  return { allowed: false, fee_minor: 0, reason: 'not_cancellable_from_' + booking.status };
}

module.exports = {
  ALLOWED_TRANSITIONS,
  isTransitionAllowed,
  tryTransition,
  haversineM,
  computeCancellationOutcome
};