const express = require('express');
const config = require('./config');
const { openDatabase } = require('./db');
const { runMigrations } = require('./migrate');
const { seedCountries } = require('./seed');
const { ensureAllCountryConfigs } = require('./countries/config');
const { seedInitialAdmin } = require('./auth/seedAdmin');
const { logger } = require('./logger');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const { attachUser } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const countriesRoutes = require('./routes/countries');
const adminRoutes = require('./routes/admin');
const superRoutes = require('./routes/super');
const customerRoutes = require('./routes/customer');
const driverRoutes = require('./routes/driver');
const agencyRoutes = require('./routes/agency');
const bookingsRoutes = require('./routes/bookings');
const dispatchRoutes = require('./routes/dispatch');
const driverBookingsRoutes = require('./routes/driverBookings');
const reportsRoutes = require('./routes/reports');
const customerPaymentsRoutes = require('./routes/customerPayments');
const driverPaymentsRoutes = require('./routes/driverPayments');
const customerSupportRoutes = require('./routes/customerSupport');
const driverSupportRoutes = require('./routes/driverSupport');
const adminSupportRoutes = require('./routes/adminSupport');

function createApp(opts = {}) {
  const log = opts.logger || logger;
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      log.info('http.request', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
    });
    next();
  });

  const db = openDatabase(config.dbPath);
  const applied = runMigrations(db, log);
  const seeded = seedCountries(db);
  const configsEnsured = ensureAllCountryConfigs(db);
  const adminSeeded = seedInitialAdmin(db, config, log);
  log.info('db.ready', { migrationsApplied: applied.length, countriesInserted: seeded, configsEnsured, adminSeeded });

  if (config.mfaRequiredForSuperAdmin) {
    const sa = db.prepare("SELECT id, mfa_enabled FROM users WHERE role = 'super_admin' LIMIT 1").get();
    if (sa && !sa.mfa_enabled) {
      log.warn('mfa.super_admin_not_enrolled', { user_id: sa.id });
    }
  }

  app.use(attachUser(db));

  app.get('/', (req, res) => res.type('text/plain').send('Vehicle Recovery App - Phase 10.0 OK'));

  app.get('/health', (req, res) => {
    let dbStatus = 'error';
    let countries = 0;
    let countriesWithSettings = 0;
    let superAdminsMfaEnabled = 0;
    let superAdminsTotal = 0;
    try {
      db.prepare('SELECT 1').get();
      dbStatus = 'ok';
      countries = db.prepare('SELECT COUNT(*) AS n FROM countries').get().n;
      countriesWithSettings = db.prepare('SELECT COUNT(*) AS n FROM country_settings').get().n;
      superAdminsTotal = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin'").get().n;
      superAdminsMfaEnabled = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND mfa_enabled = 1").get().n;
    } catch (e) { dbStatus = 'error: ' + e.message; }
    res.json({
      status: 'ok', version: config.appVersion, env: config.nodeEnv,
      database: dbStatus, countries, countries_with_settings: countriesWithSettings,
      super_admins_total: superAdminsTotal, super_admins_mfa_enabled: superAdminsMfaEnabled,
      mfa_required_for_super_admin: config.mfaRequiredForSuperAdmin,
      dispatch: {
        offer_timeout_ms: config.dispatch.offerTimeoutMs,
        radius_rounds_km: config.dispatch.radiusRoundsKm,
        max_offers_per_round: config.dispatch.maxOffersPerRound
      },
      trip: {
        arrival_gps_threshold_m: config.trip.arrivalGpsThresholdM,
        allow_manual_arrival_fallback: config.trip.allowManualArrivalFallback
      },
      payments: {
        test_online_allowed: config.nodeEnv !== 'production'
      },
      time: new Date().toISOString()
    });
  });

  app.use('/api/auth', authRoutes.routes(db, config));
  app.use('/api/countries', countriesRoutes.routes(db));
  app.use('/api/admin/reports', reportsRoutes.routes(db));
  app.use('/api/admin', adminSupportRoutes.routes(db));
  app.use('/api/admin', adminRoutes.routes(db));
  app.use('/api/super', superRoutes.routes(db, config));
  app.use('/api/customer/bookings', customerPaymentsRoutes.routes(db));
  app.use('/api/customer', customerSupportRoutes.routes(db));
  app.use('/api/customer/bookings', dispatchRoutes.routes(db));
  app.use('/api/customer/bookings', bookingsRoutes.routes(db));
  app.use('/api/customer', customerRoutes.routes(db));
  app.use('/api/driver/bookings', driverPaymentsRoutes.routes(db));
  app.use('/api/driver', driverSupportRoutes.routes(db));
  app.use('/api/driver/bookings', driverBookingsRoutes.routes(db));
  app.use('/api/driver', driverRoutes.routes(db));
  app.use('/api/agency', agencyRoutes.routes(db));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, db, logger: log };
}

module.exports = { createApp };