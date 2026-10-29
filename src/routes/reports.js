const express = require('express');
const { requireRole } = require('../middleware/auth');
const R = require('../reports/index');
const config = require('../config');

function routes(db) {
  const r = express.Router();
  r.use(requireRole('country_admin', 'super_admin'));

  function parseFilters(q) {
    return { from: q.from, to: q.to, status: q.status, service_type: q.service_type, driver_id: q.driver_id };
  }

  r.get('/bookings', (req, res, next) => {
    try {
      const filters = parseFilters(req.query);
      const all = R.queryBookings(db, req.user, filters);
      const page = R.paginate(all, { page: req.query.page, pageSize: req.query.page_size, maxPageSize: config.reports.maxPageSize });
      res.json({ filters, ...page });
    } catch (e) { next(e); }
  });

  r.get('/bookings.csv', (req, res, next) => {
    try {
      const filters = parseFilters(req.query);
      const all = R.queryBookings(db, req.user, filters);
      const headers = ['id', 'booking_number', 'created_at', 'status', 'service_type', 'service_level',
                       'agreed_fare_minor', 'currency_code', 'driver_id', 'driver_name', 'driver_email',
                       'customer_name', 'customer_email', 'country_id'];
      const csv = R.toCsv(headers, all);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="bookings-' + Date.now() + '.csv"');
      res.send(csv);
    } catch (e) { next(e); }
  });

  r.get('/financials', (req, res, next) => {
    try {
      const filters = parseFilters(req.query);
      const totals = R.computeFinancials(db, req.user, filters);
      res.json({ filters, by_currency: totals });
    } catch (e) { next(e); }
  });

  r.get('/drivers', (req, res, next) => {
    try {
      const filters = parseFilters(req.query);
      const stats = R.computeDriverStats(db, req.user, filters);
      res.json({ filters, drivers: stats });
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { routes };