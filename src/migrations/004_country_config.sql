-- Phase 4.1 - Country configuration tables
CREATE TABLE IF NOT EXISTS country_settings (
  country_id INTEGER PRIMARY KEY REFERENCES countries(id),
  tax_rate_bp INTEGER NOT NULL DEFAULT 500 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  tax_label TEXT NOT NULL DEFAULT 'VAT',
  cancellation_fee_minor INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_fee_minor >= 0),
  free_cancel_seconds INTEGER NOT NULL DEFAULT 300 CHECK (free_cancel_seconds >= 0),
  driver_acceptance_timeout_sec INTEGER NOT NULL DEFAULT 20 CHECK (driver_acceptance_timeout_sec > 0),
  max_dispatch_radius_km INTEGER NOT NULL DEFAULT 30 CHECK (max_dispatch_radius_km > 0),
  driver_pickup_max_km INTEGER NOT NULL DEFAULT 15 CHECK (driver_pickup_max_km > 0),
  support_phone TEXT,
  support_email TEXT,
  invoice_company_name TEXT,
  invoice_company_address TEXT,
  invoice_tax_id TEXT,
  contact_privacy_mode TEXT NOT NULL DEFAULT 'show_number' CHECK (contact_privacy_mode IN ('show_number','mask','hidden')),
  enabled_languages TEXT NOT NULL DEFAULT 'en,ar',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by_user_id INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS country_services (
  country_id INTEGER NOT NULL REFERENCES countries(id),
  service_code TEXT NOT NULL CHECK (service_code IN ('towing','accident','flatbed_transport','jump_start','tyre_change','fuel_delivery','lockout','winching')),
  is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0,1)),
  base_fare_minor INTEGER NOT NULL DEFAULT 0 CHECK (base_fare_minor >= 0),
  per_km_minor INTEGER NOT NULL DEFAULT 0 CHECK (per_km_minor >= 0),
  fast_surcharge_minor INTEGER NOT NULL DEFAULT 0 CHECK (fast_surcharge_minor >= 0),
  min_fare_minor INTEGER NOT NULL DEFAULT 0 CHECK (min_fare_minor >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by_user_id INTEGER REFERENCES users(id),
  PRIMARY KEY (country_id, service_code)
);
CREATE INDEX IF NOT EXISTS ix_country_services_enabled ON country_services(country_id, is_enabled);