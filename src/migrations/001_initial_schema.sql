-- Phase 2 - Core Schema
-- Conventions:
--   INTEGER PRIMARY KEY AUTOINCREMENT for portability
--   Timestamps: ISO-8601 UTC TEXT
--   Money: INTEGER minor units (fils/cents)
--   Statuses: TEXT with CHECK constraints

CREATE TABLE IF NOT EXISTS countries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name_en TEXT NOT NULL,
  name_ar TEXT,
  currency_code TEXT NOT NULL,
  currency_symbol TEXT NOT NULL,
  dial_code TEXT NOT NULL,
  timezone TEXT NOT NULL,
  default_language TEXT NOT NULL DEFAULT 'en',
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_id INTEGER REFERENCES countries(id),
  role TEXT NOT NULL CHECK (role IN ('super_admin','country_admin','agency','driver','customer')),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','locked','deleted')),
  email_verified_at TEXT,
  phone_verified_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users(email);
CREATE INDEX IF NOT EXISTS ix_users_country_role ON users(country_id, role);
CREATE INDEX IF NOT EXISTS ix_users_status ON users(status);

CREATE TABLE IF NOT EXISTS agencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_id INTEGER NOT NULL REFERENCES countries(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  legal_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  contact_email TEXT,
  contact_phone TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','suspended')),
  rejection_reason TEXT,
  approved_at TEXT,
  suspended_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_agencies_user ON agencies(user_id);
CREATE INDEX IF NOT EXISTS ix_agencies_country_status ON agencies(country_id, status);

CREATE TABLE IF NOT EXISTS recovery_vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_id INTEGER NOT NULL REFERENCES countries(id),
  agency_id INTEGER REFERENCES agencies(id),
  plate_number TEXT NOT NULL,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('flatbed','wheel_lift','heavy_duty','roadside_assist')),
  make TEXT,
  model TEXT,
  year INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','suspended','expired')),
  insurance_expires_at TEXT,
  inspection_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(country_id, plate_number)
);
CREATE INDEX IF NOT EXISTS ix_recovery_vehicles_agency ON recovery_vehicles(agency_id);

CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_id INTEGER NOT NULL REFERENCES countries(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  agency_id INTEGER REFERENCES agencies(id),
  current_vehicle_id INTEGER REFERENCES recovery_vehicles(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','suspended')),
  is_online INTEGER NOT NULL DEFAULT 0 CHECK (is_online IN (0,1)),
  last_gps_lat REAL,
  last_gps_lng REAL,
  last_gps_at TEXT,
  rating_avg REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  rejection_reason TEXT,
  approved_at TEXT,
  suspended_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_drivers_user ON drivers(user_id);
CREATE INDEX IF NOT EXISTS ix_drivers_country_status ON drivers(country_id, status);
CREATE INDEX IF NOT EXISTS ix_drivers_agency ON drivers(agency_id);

CREATE TABLE IF NOT EXISTS customer_vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  country_id INTEGER NOT NULL REFERENCES countries(id),
  category TEXT NOT NULL CHECK (category IN ('sedan_hatchback','suv','pickup','van','bus','truck','heavy_commercial','motorcycle','three_wheeler')),
  make TEXT,
  model TEXT,
  colour TEXT,
  registration_number TEXT,
  photo_path TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_customer_vehicles_customer ON customer_vehicles(customer_id);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_number TEXT NOT NULL UNIQUE,
  country_id INTEGER NOT NULL REFERENCES countries(id),
  customer_id INTEGER NOT NULL REFERENCES users(id),
  driver_id INTEGER REFERENCES drivers(id),
  recovery_vehicle_id INTEGER REFERENCES recovery_vehicles(id),
  service_type TEXT NOT NULL CHECK (service_type IN ('towing','accident','flatbed_transport','jump_start','tyre_change','fuel_delivery','lockout','winching')),
  service_level TEXT NOT NULL DEFAULT 'normal' CHECK (service_level IN ('normal','fast')),
  customer_vehicle_snapshot_json TEXT NOT NULL,
  pickup_lat REAL NOT NULL,
  pickup_lng REAL NOT NULL,
  pickup_address TEXT,
  pickup_notes TEXT,
  destination_lat REAL NOT NULL,
  destination_lng REAL NOT NULL,
  destination_address TEXT,
  breakdown_notes TEXT,
  fare_estimate_json TEXT NOT NULL,
  agreed_fare_minor INTEGER NOT NULL,
  currency_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
    'created','searching','assigned','driver_accepted','driver_on_way',
    'driver_arrived','vehicle_loaded','trip_in_progress','trip_completed',
    'cancelled','no_driver_available',
    'payment_pending','payment_completed','payment_failed','disputed'
  )),
  accepted_at TEXT,
  arrived_at TEXT,
  loaded_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  cancellation_fee_minor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_bookings_customer ON bookings(customer_id, id);
CREATE INDEX IF NOT EXISTS ix_bookings_driver ON bookings(driver_id, id);
CREATE INDEX IF NOT EXISTS ix_bookings_country_status ON bookings(country_id, status);
CREATE INDEX IF NOT EXISTS ix_bookings_created ON bookings(created_at);

CREATE TABLE IF NOT EXISTS booking_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),
  actor_role TEXT,
  reason TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_bsh_booking ON booking_status_history(booking_id, id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  method TEXT NOT NULL CHECK (method IN ('cash','online','test')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','authorized','paid','failed','refunded','disputed')),
  amount_minor INTEGER NOT NULL,
  currency_code TEXT NOT NULL,
  provider TEXT,
  provider_ref TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_booking_method ON payments(booking_id, method);

CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  event_type TEXT NOT NULL,
  amount_minor INTEGER,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_payment_events_payment ON payment_events(payment_id, id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id),
  actor_role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  country_id INTEGER,
  metadata_json TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_audit_actor ON audit_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS ix_audit_country ON audit_logs(country_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_prt_user ON password_reset_tokens(user_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  status TEXT NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(scope, key)
);