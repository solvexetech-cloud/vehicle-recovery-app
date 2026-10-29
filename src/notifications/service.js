function notify(db, { userId, kind, title, body, data }) {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!kind || !title) return null;
  const now = new Date().toISOString();
  try {
    const r = db.prepare(
      'INSERT INTO notifications (user_id, kind, title, body, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, kind, String(title).slice(0, 200), body ? String(body).slice(0, 500) : null,
          data ? JSON.stringify(data) : null, now);
    return Number(r.lastInsertRowid);
  } catch (e) {
    // Never let notification failure break the business operation
    console.error('[notify] failed:', e.message, { userId, kind });
    return null;
  }
}

function notifyCountryAdmins(db, countryId, payload) {
  try {
    const admins = db.prepare(
      "SELECT id FROM users WHERE role = 'country_admin' AND country_id = ? AND status = 'active'"
    ).all(countryId);
    for (const a of admins) notify(db, { ...payload, userId: a.id });
    return admins.length;
  } catch (e) {
    console.error('[notifyCountryAdmins] failed:', e.message);
    return 0;
  }
}

function notifyBookingCustomer(db, bookingId, payload) {
  try {
    const b = db.prepare('SELECT customer_id FROM bookings WHERE id = ?').get(bookingId);
    if (!b) return null;
    return notify(db, { ...payload, userId: b.customer_id });
  } catch (e) {
    console.error('[notifyBookingCustomer] failed:', e.message);
    return null;
  }
}

function notifyBookingDriver(db, bookingId, payload) {
  try {
    const b = db.prepare(
      'SELECT d.user_id AS driver_user_id FROM bookings b JOIN drivers d ON d.id = b.driver_id WHERE b.id = ?'
    ).get(bookingId);
    if (!b || !b.driver_user_id) return null;
    return notify(db, { ...payload, userId: b.driver_user_id });
  } catch (e) {
    console.error('[notifyBookingDriver] failed:', e.message);
    return null;
  }
}

module.exports = { notify, notifyCountryAdmins, notifyBookingCustomer, notifyBookingDriver };
