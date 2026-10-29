-- Phase 6.2 - Dispatch offers for immediate booking
CREATE TABLE IF NOT EXISTS dispatch_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  round_number INTEGER NOT NULL DEFAULT 1,
  radius_km INTEGER NOT NULL,
  distance_km REAL NOT NULL,
  offered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  response TEXT NOT NULL DEFAULT 'pending' CHECK (response IN ('pending','accepted','rejected','expired','superseded')),
  responded_at TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS ix_dispatch_offers_booking ON dispatch_offers(booking_id, response);
CREATE INDEX IF NOT EXISTS ix_dispatch_offers_driver ON dispatch_offers(driver_id, response);
CREATE INDEX IF NOT EXISTS ix_dispatch_offers_expires ON dispatch_offers(expires_at) WHERE response = 'pending';

-- At most one live pending offer per booking at any time (single-offer flow)
CREATE UNIQUE INDEX IF NOT EXISTS ux_dispatch_offers_pending_booking
  ON dispatch_offers(booking_id) WHERE response = 'pending';

-- A driver can have at most one live pending offer at any time
CREATE UNIQUE INDEX IF NOT EXISTS ux_dispatch_offers_pending_driver
  ON dispatch_offers(driver_id) WHERE response = 'pending';