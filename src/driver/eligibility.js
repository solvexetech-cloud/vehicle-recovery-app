const GPS_FRESH_MS = 5 * 60 * 1000;

function evaluateEligibility(db, driverId, now = new Date()) {
  const reasons = [];
  const d = db.prepare(
    'SELECT d.id, d.user_id, d.country_id, d.agency_id, d.current_vehicle_id, d.status, d.is_online, ' +
    '       d.last_gps_lat, d.last_gps_lng, d.last_gps_at, ' +
    '       u.status AS user_status, ' +
    '       a.status AS agency_status, a.id AS agency_id_joined ' +
    'FROM drivers d ' +
    'LEFT JOIN users u ON u.id = d.user_id ' +
    'LEFT JOIN agencies a ON a.id = d.agency_id ' +
    'WHERE d.id = ?'
  ).get(driverId);

  if (!d) return { eligible: false, reasons: ['driver_not_found'], snapshot: null };

  if (d.status !== 'approved') reasons.push('driver_not_approved');
  if (d.user_status !== 'active') reasons.push('user_not_active');
  if (d.agency_id_joined && d.agency_status !== 'approved') reasons.push('agency_not_approved');

  // Required documents + expiry
  const docs = db.prepare(
    "SELECT doc_type, review_status, expires_at FROM driver_documents WHERE driver_id = ?"
  ).all(driverId);

  const required = ['driving_license'];
  const docStatus = {};
  for (const dt of required) {
    const matches = docs.filter((x) => x.doc_type === dt && x.review_status === 'approved');
    if (matches.length === 0) {
      reasons.push('missing_required_document:' + dt);
      docStatus[dt] = 'missing';
    } else {
      const best = matches.sort((a, b) => String(b.expires_at || '').localeCompare(String(a.expires_at || '')))[0];
      if (best.expires_at && new Date(best.expires_at).getTime() < now.getTime()) {
        reasons.push('expired_document:' + dt);
        docStatus[dt] = 'expired';
      } else {
        docStatus[dt] = 'ok';
      }
    }
  }

  // Vehicle: current_vehicle_id set + approved + authorization
  let vehicleStatus = 'not_selected';
  if (d.current_vehicle_id) {
    const v = db.prepare('SELECT id, status, agency_id FROM recovery_vehicles WHERE id = ?').get(d.current_vehicle_id);
    if (!v) {
      reasons.push('vehicle_not_found');
      vehicleStatus = 'missing';
    } else if (v.status !== 'approved') {
      reasons.push('vehicle_not_approved');
      vehicleStatus = v.status;
    } else if (d.agency_id && v.agency_id && v.agency_id !== d.agency_id) {
      reasons.push('vehicle_not_from_agency');
      vehicleStatus = 'wrong_agency';
    } else {
      const auth = db.prepare('SELECT 1 AS ok FROM driver_vehicles WHERE driver_id = ? AND recovery_vehicle_id = ? AND revoked_at IS NULL')
        .get(driverId, d.current_vehicle_id);
      if (!auth) {
        reasons.push('vehicle_not_authorized');
        vehicleStatus = 'unauthorized';
      } else {
        vehicleStatus = 'ok';
      }
    }
  } else {
    reasons.push('no_vehicle_selected');
  }

  // GPS freshness
  let gpsStatus = 'missing';
  if (d.last_gps_lat !== null && d.last_gps_lng !== null && d.last_gps_at) {
    const ageMs = now.getTime() - new Date(d.last_gps_at).getTime();
    if (ageMs > GPS_FRESH_MS) {
      reasons.push('gps_stale');
      gpsStatus = 'stale';
    } else {
      gpsStatus = 'ok';
    }
  } else {
    reasons.push('gps_missing');
  }

  // Online
  if (!d.is_online) reasons.push('driver_offline');

  return {
    eligible: reasons.length === 0,
    reasons,
    snapshot: {
      driver_status: d.status,
      user_status: d.user_status,
      agency_status: d.agency_status || null,
      vehicle_status: vehicleStatus,
      gps_status: gpsStatus,
      is_online: !!d.is_online,
      documents: docStatus,
      current_vehicle_id: d.current_vehicle_id || null
    }
  };
}

module.exports = { evaluateEligibility, GPS_FRESH_MS };