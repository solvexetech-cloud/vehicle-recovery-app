const PAYABLE_FROM = new Set(['trip_completed', 'payment_pending']);
const DISPUTABLE_FROM = new Set(['trip_completed', 'payment_pending', 'payment_completed']);

function findPaymentByMethod(db, bookingId, method) {
  return db.prepare('SELECT * FROM payments WHERE booking_id = ? AND method = ?').get(bookingId, method);
}

function listPayments(db, bookingId) {
  return db.prepare('SELECT * FROM payments WHERE booking_id = ? ORDER BY id').all(bookingId);
}

function listEvents(db, paymentId) {
  return db.prepare('SELECT * FROM payment_events WHERE payment_id = ? ORDER BY id').all(paymentId);
}

function createPayment(db, { booking, method, status, provider, providerRef, idempotencyKey }) {
  const now = new Date().toISOString();
  const r = db.prepare(
    'INSERT INTO payments (booking_id, method, status, amount_minor, currency_code, provider, provider_ref, idempotency_key, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(booking.id, method, status, booking.agreed_fare_minor, booking.currency_code,
        provider || null, providerRef || null, idempotencyKey || null, now, now);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(r.lastInsertRowid));
}

function updatePaymentStatus(db, paymentId, status) {
  const now = new Date().toISOString();
  db.prepare('UPDATE payments SET status = ?, updated_at = ? WHERE id = ?').run(status, now, paymentId);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
}

function recordEvent(db, { paymentId, eventType, amountMinor, payload }) {
  db.prepare(
    'INSERT INTO payment_events (payment_id, event_type, amount_minor, payload_json) VALUES (?, ?, ?, ?)'
  ).run(paymentId, eventType,
        (amountMinor !== undefined && amountMinor !== null) ? amountMinor : null,
        payload ? JSON.stringify(payload) : null);
}

function summarizeStatus(payments) {
  if (payments.some((p) => p.status === 'disputed')) return 'disputed';
  if (payments.some((p) => p.status === 'paid')) return 'paid';
  if (payments.some((p) => p.status === 'authorized')) return 'authorized';
  if (payments.some((p) => p.status === 'failed')) return 'failed';
  return 'pending';
}

module.exports = {
  PAYABLE_FROM, DISPUTABLE_FROM,
  findPaymentByMethod, listPayments, listEvents,
  createPayment, updatePaymentStatus, recordEvent, summarizeStatus
};