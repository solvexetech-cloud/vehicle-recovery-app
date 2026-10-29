function audit(db, entry) {
  const {
    actor_user_id = null, actor_role = null, action,
    entity_type = null, entity_id = null, country_id = null,
    metadata = null, ip = null, user_agent = null
  } = entry;
  if (!action) throw new Error('audit: action required');
  db.prepare(
    'INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, country_id, metadata_json, ip, user_agent) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(actor_user_id, actor_role, action, entity_type, entity_id, country_id,
        metadata ? JSON.stringify(metadata) : null, ip, user_agent);
}

module.exports = { audit };