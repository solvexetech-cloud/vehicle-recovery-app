-- Phase 5.1 - Customer destinations + saved-item limits per country
CREATE TABLE IF NOT EXISTS customer_destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  country_id INTEGER NOT NULL REFERENCES countries(id),
  label TEXT NOT NULL,
  address TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  contact_phone TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_customer_destinations_customer ON customer_destinations(customer_id);

ALTER TABLE country_settings ADD COLUMN max_saved_vehicles INTEGER NOT NULL DEFAULT 5;
ALTER TABLE country_settings ADD COLUMN max_saved_destinations INTEGER NOT NULL DEFAULT 10;