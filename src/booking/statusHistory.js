function recordStatus(db, { bookingId, fromStatus, toStatus, actorUserId, actorRole, reason, metadata }) {
  db.prepare(
    'INSERT INTO booking_status_history (booking_id, from_status, to_status, actor_user_id, actor_role, reason, metadata_json) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    bookingId,
    fromStatus || null,
    toStatus,
    actorUserId || null,
    actorRole || null,
    reason || null,
    metadata ? JSON.stringify(metadata) : null
  );
}

module.exports = { recordStatus };