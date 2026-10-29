-- Phase 10 - Commission for reports
ALTER TABLE country_settings ADD COLUMN commission_rate_bp INTEGER NOT NULL DEFAULT 1500;
CREATE INDEX IF NOT EXISTS ix_bookings_created_status ON bookings(country_id, created_at, status);
CREATE INDEX IF NOT EXISTS ix_payments_status ON payments(status, booking_id);