const path = require('node:path');
require('dotenv').config();

module.exports = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db'),
  logLevel: process.env.LOG_LEVEL || 'info',
  mfaRequiredForSuperAdmin: (process.env.MFA_REQUIRED_FOR_SUPER_ADMIN || 'false').toLowerCase() === 'true',
  uploadsDir: process.env.UPLOADS_DIR || path.join(__dirname, '..', 'data', 'uploads'),
  driverDocMaxBytes: 2 * 1024 * 1024,
  dispatch: {
    offerTimeoutMs: Number(process.env.DISPATCH_OFFER_TIMEOUT_MS || 20000),
    radiusRoundsKm: (process.env.DISPATCH_RADIUS_ROUNDS_KM || '5,10,30').split(',').map(Number).filter((n) => n > 0),
    maxOffersPerRound: Number(process.env.DISPATCH_MAX_OFFERS_PER_ROUND || 10)
  },
  trip: {
    arrivalGpsThresholdM: Number(process.env.TRIP_ARRIVAL_GPS_THRESHOLD_M || 200),
    allowManualArrivalFallback: (process.env.TRIP_ALLOW_MANUAL_ARRIVAL_FALLBACK || 'true').toLowerCase() === 'true'
  },
  support: {
    ticketSubjectMaxLen: 120,
    ticketDescriptionMaxLen: 4000,
    ticketMessageMaxLen: 2000,
    chatMessageMaxLen: 1000,
    notificationBodyMaxLen: 500
  },
  appVersion: '0.9.0'
};