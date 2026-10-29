const SERVICE_CODES = ['towing','accident','flatbed_transport','jump_start','tyre_change','fuel_delivery','lockout','winching'];

function ensureCountryConfig(db, countryId, opts = {}) {
  const settingsInfo = db.prepare('INSERT OR IGNORE INTO country_settings (country_id) VALUES (?)').run(countryId);
  const wasCreated = (settingsInfo.changes || 0) > 0;

  const stmt = db.prepare('INSERT OR IGNORE INTO country_services (country_id, service_code) VALUES (?, ?)');
  let servicesCreated = 0;
  for (const code of SERVICE_CODES) {
    const r = stmt.run(countryId, code);
    servicesCreated += (r.changes || 0);
  }

  // Dev demo: enable towing + jump_start for QA on first config creation only.
  // Admin toggles later are preserved (this block runs only when settings row is new).
  if (wasCreated && opts.code === 'QA') {
    db.prepare(
      "UPDATE country_services SET is_enabled = 1 WHERE country_id = ? AND service_code IN ('towing','jump_start')"
    ).run(countryId);
  }
  return { wasCreated, servicesCreated };
}

function ensureAllCountryConfigs(db) {
  const all = db.prepare('SELECT id, code FROM countries').all();
  for (const c of all) ensureCountryConfig(db, c.id, { code: c.code });
  return all.length;
}

module.exports = { ensureCountryConfig, ensureAllCountryConfigs, SERVICE_CODES };