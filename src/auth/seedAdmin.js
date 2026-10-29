const { hashPasswordSync } = require('./index');
const { audit } = require('../audit');

function seedInitialAdmin(db, config, logger) {
  if (config.nodeEnv === 'production') return false;

  const existing = db.prepare("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1").get();
  if (existing) return false;

  const email = 'superadmin@vra.local';
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD || 'ChangeMe-Admin-2026!';
  const pwHash = hashPasswordSync(password);

  const r = db.prepare(
    "INSERT INTO users (country_id, role, full_name, email, password_hash, status, email_verified_at) VALUES (NULL, 'super_admin', 'Super Admin', ?, ?, 'active', ?)"
  ).run(email, pwHash, new Date().toISOString());

  audit(db, {
    actor_user_id: Number(r.lastInsertRowid), actor_role: 'super_admin',
    action: 'user.seed_super_admin', entity_type: 'user', entity_id: Number(r.lastInsertRowid),
    metadata: { email }
  });

  if (logger) {
    logger.info('auth.seed_super_admin', { email });
    console.log('');
    console.log('========== DEV SUPER ADMIN ==========');
    console.log('  Email:    ' + email);
    console.log('  Password: ' + password);
    console.log('  Change this in production!');
    console.log('=====================================');
    console.log('');
  }
  return true;
}

module.exports = { seedInitialAdmin };