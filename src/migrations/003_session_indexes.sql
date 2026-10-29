-- Phase 3.2 - Session and admin query indexes
CREATE INDEX IF NOT EXISTS ix_sessions_user_revoked ON sessions(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS ix_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS ix_users_role_country ON users(role, country_id);