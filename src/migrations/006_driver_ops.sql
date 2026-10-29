-- Phase 5.2 - Driver documents + agency driver/vehicle authorization
CREATE TABLE IF NOT EXISTS driver_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('driving_license','national_id','vehicle_registration','insurance','inspection','operating_permit','other')),
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  expires_at TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected','expired')),
  rejection_reason TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_driver_docs_driver ON driver_documents(driver_id);
CREATE INDEX IF NOT EXISTS ix_driver_docs_type ON driver_documents(driver_id, doc_type);

CREATE TABLE IF NOT EXISTS driver_vehicles (
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  recovery_vehicle_id INTEGER NOT NULL REFERENCES recovery_vehicles(id),
  authorized_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  PRIMARY KEY (driver_id, recovery_vehicle_id)
);
CREATE INDEX IF NOT EXISTS ix_driver_vehicles_driver ON driver_vehicles(driver_id);