-- Phase 5.3 - Agency fleet + authorization lookups
CREATE INDEX IF NOT EXISTS ix_driver_vehicles_by_vehicle ON driver_vehicles(recovery_vehicle_id, revoked_at);
CREATE INDEX IF NOT EXISTS ix_recovery_vehicles_status ON recovery_vehicles(status, country_id);