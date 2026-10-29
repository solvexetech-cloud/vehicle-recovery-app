function normalizeDate(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + 'T00:00:00.000Z';
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  return null;
}

function scopeClause(actor, params) {
  if (actor.role === 'country_admin') {
    params.push(actor.country_id);
    return ' AND b.country_id = ?';
  }
  return '';
}

function getCommissionBp(db, countryId) {
  const row = db.prepare('SELECT commission_rate_bp FROM country_settings WHERE country_id = ?').get(countryId);
  return row ? row.commission_rate_bp : 1500;
}

function queryBookings(db, actor, filters = {}) {
  const params = [];
  let where = '1=1';
  where += scopeClause(actor, params);
  const from = normalizeDate(filters.from);
  const to = normalizeDate(filters.to);
  if (from) { where += ' AND b.created_at >= ?'; params.push(from); }
  if (to)   { where += ' AND b.created_at <= ?'; params.push(to); }
  if (filters.status) { where += ' AND b.status = ?'; params.push(String(filters.status)); }
  if (filters.service_type) { where += ' AND b.service_type = ?'; params.push(String(filters.service_type)); }
  if (filters.driver_id) {
    const did = Number(filters.driver_id);
    if (Number.isInteger(did) && did > 0) { where += ' AND b.driver_id = ?'; params.push(did); }
  }
  const sql =
    "SELECT b.id, b.booking_number, b.country_id, b.created_at, b.status, b.service_type, b.service_level, " +
    "       b.agreed_fare_minor, b.currency_code, b.driver_id, " +
    "       cu.email AS customer_email, cu.full_name AS customer_name, " +
    "       du.email AS driver_email, du.full_name AS driver_name " +
    "FROM bookings b " +
    "LEFT JOIN users cu ON cu.id = b.customer_id " +
    "LEFT JOIN drivers d ON d.id = b.driver_id " +
    "LEFT JOIN users du ON du.id = d.user_id " +
    "WHERE " + where + " ORDER BY b.id DESC";
  return db.prepare(sql).all(...params);
}

function computeFinancials(db, actor, filters = {}) {
  const bookings = queryBookings(db, actor, filters);
  const byCurrency = {};
  for (const b of bookings) {
    const c = b.currency_code || 'UNKNOWN';
    if (!byCurrency[c]) {
      byCurrency[c] = {
        currency_code: c, total_bookings: 0, paid_bookings: 0, disputed_bookings: 0, cancelled_bookings: 0,
        gross_fare_minor: 0, commission_minor: 0, net_to_drivers_minor: 0,
        cash_paid_minor: 0, online_paid_minor: 0
      };
    }
    const cur = byCurrency[c];
    cur.total_bookings += 1;
    if (b.status === 'payment_completed') cur.paid_bookings += 1;
    if (b.status === 'disputed') cur.disputed_bookings += 1;
    if (b.status === 'cancelled') cur.cancelled_bookings += 1;
    if (b.status === 'payment_completed' || b.status === 'disputed') {
      cur.gross_fare_minor += b.agreed_fare_minor;
      const bp = getCommissionBp(db, b.country_id);
      const comm = Math.round((b.agreed_fare_minor * bp) / 10000);
      cur.commission_minor += comm;
      cur.net_to_drivers_minor += (b.agreed_fare_minor - comm);
    }
  }
  const ids = bookings.map((b) => b.id);
  if (ids.length > 0) {
    const ph = ids.map(() => '?').join(',');
    const pays = db.prepare(
      'SELECT p.method, p.amount_minor, b.currency_code ' +
      'FROM payments p JOIN bookings b ON b.id = p.booking_id ' +
      'WHERE p.booking_id IN (' + ph + ") AND p.status = 'paid'"
    ).all(...ids);
    for (const p of pays) {
      const c = p.currency_code;
      if (!byCurrency[c]) continue;
      if (p.method === 'cash') byCurrency[c].cash_paid_minor += p.amount_minor;
      else byCurrency[c].online_paid_minor += p.amount_minor;
    }
  }
  return Object.values(byCurrency);
}

function computeDriverStats(db, actor, filters = {}) {
  const bookings = queryBookings(db, actor, filters);
  const byDriver = {};
  for (const b of bookings) {
    if (!b.driver_id) continue;
    if (!byDriver[b.driver_id]) {
      byDriver[b.driver_id] = {
        driver_id: b.driver_id, driver_name: b.driver_name, driver_email: b.driver_email,
        total_bookings: 0, completed: 0, cancelled: 0, disputed: 0,
        gross_fare_minor: 0, currency_code: b.currency_code
      };
    }
    const d = byDriver[b.driver_id];
    d.total_bookings += 1;
    if (b.status === 'payment_completed') d.completed += 1;
    if (b.status === 'cancelled') d.cancelled += 1;
    if (b.status === 'disputed') d.disputed += 1;
    if (b.status === 'payment_completed') d.gross_fare_minor += b.agreed_fare_minor;
  }
  for (const d of Object.values(byDriver)) {
    const r = db.prepare('SELECT rating_avg, rating_count FROM drivers WHERE id = ?').get(d.driver_id);
    d.rating_avg = r ? r.rating_avg : 0;
    d.rating_count = r ? r.rating_count : 0;
  }
  return Object.values(byDriver).sort((a, b) => b.completed - a.completed);
}

function computeCountryAnalytics(db) {
  const rows = db.prepare(
    'SELECT c.id, c.code, c.name_en, c.currency_code, c.is_active, ' +
    "  (SELECT COUNT(*) FROM bookings b WHERE b.country_id = c.id) AS total_bookings, " +
    "  (SELECT COUNT(*) FROM bookings b WHERE b.country_id = c.id AND b.status = 'payment_completed') AS completed_bookings, " +
    "  (SELECT COUNT(*) FROM bookings b WHERE b.country_id = c.id AND b.status = 'disputed') AS disputed_bookings, " +
    "  (SELECT COALESCE(SUM(b.agreed_fare_minor),0) FROM bookings b WHERE b.country_id = c.id AND b.status = 'payment_completed') AS gross_minor, " +
    "  (SELECT COUNT(*) FROM drivers d WHERE d.country_id = c.id) AS total_drivers, " +
    "  (SELECT COUNT(*) FROM recovery_vehicles rv WHERE rv.country_id = c.id) AS total_vehicles " +
    'FROM countries c ORDER BY c.code'
  ).all();
  for (const r of rows) {
    const bp = getCommissionBp(db, r.id);
    r.commission_minor = Math.round((r.gross_minor * bp) / 10000);
    r.net_to_drivers_minor = r.gross_minor - r.commission_minor;
  }
  return rows;
}

function paginate(rows, { page = 1, pageSize = 50, maxPageSize = 200 } = {}) {
  const ps = Math.min(Math.max(Number(pageSize) || 50, 1), maxPageSize);
  const pg = Math.max(Number(page) || 1, 1);
  const start = (pg - 1) * ps;
  return { page: pg, page_size: ps, total: rows.length, rows: rows.slice(start, start + ps) };
}

function toCsv(headers, rows) {
  function esc(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  const lines = [headers.map(esc).join(',')];
  for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  queryBookings, computeFinancials, computeDriverStats,
  computeCountryAnalytics, paginate, toCsv, getCommissionBp, normalizeDate
};