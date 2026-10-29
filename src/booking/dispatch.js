const { haversineKm, roundKm } = require('./fare');
const { evaluateEligibility } = require('../driver/eligibility');
const { recordStatus } = require('./statusHistory');

const DEFAULT_OFFER_TIMEOUT_MS = 20000;
const DEFAULT_RADIUS_ROUNDS = [5, 10, 30];
const DEFAULT_MAX_OFFERS_PER_ROUND = 10;

function cfgOpts(cfg) {
  const d = (cfg && cfg.dispatch) || {};
  return {
    offerTimeoutMs: d.offerTimeoutMs || DEFAULT_OFFER_TIMEOUT_MS,
    radiusRounds: (d.radiusRoundsKm && d.radiusRoundsKm.length ? d.radiusRoundsKm : DEFAULT_RADIUS_ROUNDS),
    maxOffersPerRound: d.maxOffersPerRound || DEFAULT_MAX_OFFERS_PER_ROUND
  };
}

function nowIso() { return new Date().toISOString(); }
function addMs(iso, ms) { return new Date(new Date(iso).getTime() + ms).toISOString(); }

/**
 * Find candidate drivers within radius, excluding anyone who has already
 * received an offer on this booking and excluding drivers with an active booking.
 * Returns array sorted by ascending distance.
 */
function findCandidateDrivers(db, { booking, radiusKm, alreadyOfferedDriverIds, maxCount }) {
  const drivers = db.prepare(
    "SELECT d.id, d.user_id, d.country_id, d.current_vehicle_id, d.status, d.is_online, " +
    "       d.last_gps_lat, d.last_gps_lng, d.last_gps_at, d.agency_id " +
    "FROM drivers d " +
    "WHERE d.country_id = ? AND d.status = 'approved' AND d.is_online = 1 " +
    "  AND d.last_gps_lat IS NOT NULL AND d.last_gps_lng IS NOT NULL " +
    "  AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.driver_id = d.id AND b.status NOT IN ('cancelled','trip_completed','payment_completed','payment_failed','no_driver_available')) " +
    "  AND NOT EXISTS (SELECT 1 FROM dispatch_offers dfo WHERE dfo.driver_id = d.id AND dfo.response = 'pending')"
  ).all(booking.country_id);

  const offerset = new Set((alreadyOfferedDriverIds || []).map((x) => Number(x)));
  const candidates = [];

  for (const d of drivers) {
    if (offerset.has(d.id)) continue;
    const elig = evaluateEligibility(db, d.id);
    if (!elig.eligible) continue;

    const distance = roundKm(haversineKm(booking.pickup_lat, booking.pickup_lng, d.last_gps_lat, d.last_gps_lng));
    if (distance > radiusKm) continue;

    candidates.push({ driver_id: d.id, distance_km: distance, last_gps_at: d.last_gps_at });
  }
  candidates.sort((a, b) => a.distance_km - b.distance_km);
  return candidates.slice(0, maxCount);
}

/**
 * Expire any pending offers whose expires_at < now for this booking.
 * Returns list of expired offers (driver_ids).
 */
function expireStaleOffers(db, bookingId, now = nowIso()) {
  const stale = db.prepare(
    "SELECT id, driver_id FROM dispatch_offers WHERE booking_id = ? AND response = 'pending' AND expires_at < ?"
  ).all(bookingId, now);
  if (stale.length === 0) return [];
  for (const s of stale) {
    db.prepare("UPDATE dispatch_offers SET response = 'expired', responded_at = ?, reason = 'timeout' WHERE id = ?")
      .run(now, s.id);
  }
  return stale.map((s) => s.driver_id);
}

/**
 * Create a new pending offer to a driver. Throws on UNIQUE constraint (safe — caller retries).
 */
function createOffer(db, { bookingId, driverId, roundNumber, radiusKm, distanceKm, expiresAt }) {
  const r = db.prepare(
    "INSERT INTO dispatch_offers (booking_id, driver_id, round_number, radius_km, distance_km, expires_at, response) " +
    "VALUES (?, ?, ?, ?, ?, ?, 'pending')"
  ).run(bookingId, driverId, roundNumber, radiusKm, distanceKm, expiresAt);
  return Number(r.lastInsertRowid);
}

/**
 * Advance dispatch. Idempotent-safe: caller holds transaction or exclusive lock semantics.
 * - Expires stale offers
 * - If booking already assigned/completed, return
 * - If there's a live pending offer, return that offer
 * - Otherwise try to create next offer (same round remaining candidates, then next round radius)
 * - If no more candidates across all rounds, mark booking no_driver_available
 *
 * Returns:
 *   { status: 'already_assigned' | 'already_terminal' | 'pending_offer' | 'offer_created' | 'no_driver' | 'not_searching', offer?, driver_id? }
 */
function advanceDispatch(db, { bookingId, cfg, now = nowIso(), actorUserId = null, actorRole = 'system' }) {
  const opts = cfgOpts(cfg);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return { status: 'not_found' };
  if (!['created', 'searching'].includes(booking.status)) {
    return { status: 'already_terminal', booking_status: booking.status };
  }

  // Transition created -> searching once
  if (booking.status === 'created') {
    db.prepare("UPDATE bookings SET status = 'searching', updated_at = ? WHERE id = ? AND status = 'created'")
      .run(now, bookingId);
    recordStatus(db, {
      bookingId, fromStatus: 'created', toStatus: 'searching',
      actorUserId, actorRole, reason: 'dispatch_started'
    });
  }

  // Expire stale offers first
  expireStaleOffers(db, bookingId, now);

  // Live pending offer?
  const live = db.prepare(
    "SELECT * FROM dispatch_offers WHERE booking_id = ? AND response = 'pending' ORDER BY id DESC LIMIT 1"
  ).get(bookingId);
  if (live) return { status: 'pending_offer', offer: live };

  // Determine next candidate: prefer same round radius, then expand
  const offeredDriverIds = db.prepare(
    "SELECT driver_id FROM dispatch_offers WHERE booking_id = ?"
  ).all(bookingId).map((r) => r.driver_id);

  const rounds = opts.radiusRounds;
  let chosen = null;
  let chosenRound = null;

  for (let i = 0; i < rounds.length; i++) {
    const radius = rounds[i];
    const cands = findCandidateDrivers(db, {
      booking, radiusKm: radius,
      alreadyOfferedDriverIds: offeredDriverIds,
      maxCount: opts.maxOffersPerRound
    });
    if (cands.length > 0) { chosen = cands[0]; chosenRound = { round: i + 1, radius }; break; }
  }

  if (!chosen) {
    // No drivers within the largest configured radius -> no_driver_available
    db.prepare("UPDATE bookings SET status = 'no_driver_available', updated_at = ? WHERE id = ? AND status = 'searching'")
      .run(now, bookingId);
    recordStatus(db, {
      bookingId, fromStatus: 'searching', toStatus: 'no_driver_available',
      actorUserId, actorRole, reason: 'no_driver_in_radius',
      metadata: { radius_rounds_km: rounds, offers_sent: offeredDriverIds.length }
    });
    return { status: 'no_driver', offers_sent: offeredDriverIds.length };
  }

  const expiresAt = addMs(now, opts.offerTimeoutMs);
  try {
    const offerId = createOffer(db, {
      bookingId, driverId: chosen.driver_id,
      roundNumber: chosenRound.round, radiusKm: chosenRound.radius,
      distanceKm: chosen.distance_km, expiresAt
    });
    const offer = db.prepare('SELECT * FROM dispatch_offers WHERE id = ?').get(offerId);
    return { status: 'offer_created', offer };
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) {
      // Race lost (someone else created a pending offer for this driver or booking)
      const liveNow = db.prepare(
        "SELECT * FROM dispatch_offers WHERE booking_id = ? AND response = 'pending' ORDER BY id DESC LIMIT 1"
      ).get(bookingId);
      if (liveNow) return { status: 'pending_offer', offer: liveNow };
      return { status: 'race_lost' };
    }
    throw e;
  }
}

/**
 * Atomic accept. Returns:
 *   { ok: true, booking } if winner
 *   { ok: false, reason } otherwise
 */
function tryAccept(db, { bookingId, driverId, now = nowIso() }) {
  // Verify live offer exists for this driver and hasn't expired
  const offer = db.prepare(
    "SELECT * FROM dispatch_offers WHERE booking_id = ? AND driver_id = ? AND response = 'pending' ORDER BY id DESC LIMIT 1"
  ).get(bookingId, driverId);
  if (!offer) return { ok: false, reason: 'no_active_offer' };
  if (offer.expires_at < now) {
    db.prepare("UPDATE dispatch_offers SET response = 'expired', responded_at = ?, reason = 'timeout_accept' WHERE id = ?")
      .run(now, offer.id);
    return { ok: false, reason: 'offer_expired' };
  }

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return { ok: false, reason: 'booking_not_found' };
  if (booking.status !== 'searching') return { ok: false, reason: 'booking_not_searching', status: booking.status };

  // Verify eligibility at accept time
  const elig = evaluateEligibility(db, driverId, new Date(now));
  if (!elig.eligible) return { ok: false, reason: 'driver_not_eligible_at_accept', blockers: elig.reasons };

  // Fetch driver to get current vehicle
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
  if (!driver || !driver.current_vehicle_id) return { ok: false, reason: 'no_current_vehicle' };

  // ATOMIC WIN: single UPDATE ... WHERE status = 'searching'
  const upd = db.prepare(
    "UPDATE bookings SET driver_id = ?, recovery_vehicle_id = ?, status = 'assigned', accepted_at = ?, updated_at = ? " +
    "WHERE id = ? AND status = 'searching'"
  ).run(driverId, driver.current_vehicle_id, now, now, bookingId);

  if (upd.changes !== 1) {
    // Another driver won
    return { ok: false, reason: 'lost_race' };
  }

  db.prepare("UPDATE dispatch_offers SET response = 'accepted', responded_at = ? WHERE id = ?").run(now, offer.id);
  // Supersede any other pending offers for this booking (shouldn't exist but be safe)
  db.prepare("UPDATE dispatch_offers SET response = 'superseded', responded_at = ?, reason = 'other_driver_accepted' " +
             "WHERE booking_id = ? AND response = 'pending'").run(now, bookingId);

  recordStatus(db, {
    bookingId, fromStatus: 'searching', toStatus: 'assigned',
    actorUserId: driver.user_id, actorRole: 'driver',
    metadata: { driver_id: driverId, offer_id: offer.id, distance_km: offer.distance_km, radius_km: offer.radius_km }
  });

  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  return { ok: true, booking: updated, driver };
}

function tryReject(db, { bookingId, driverId, reason = 'driver_rejected', now = nowIso() }) {
  const offer = db.prepare(
    "SELECT * FROM dispatch_offers WHERE booking_id = ? AND driver_id = ? AND response = 'pending' ORDER BY id DESC LIMIT 1"
  ).get(bookingId, driverId);
  if (!offer) return { ok: false, reason: 'no_active_offer' };
  db.prepare("UPDATE dispatch_offers SET response = 'rejected', responded_at = ?, reason = ? WHERE id = ?")
    .run(now, reason, offer.id);
  return { ok: true };
}

/**
 * Return the live pending offer for a driver (single or null).
 */
function getLiveOfferForDriver(db, driverId, now = nowIso()) {
  // Expire first for this driver's pending offer if applicable
  const pending = db.prepare(
    "SELECT * FROM dispatch_offers WHERE driver_id = ? AND response = 'pending' ORDER BY id DESC LIMIT 1"
  ).get(driverId);
  if (!pending) return null;
  if (pending.expires_at < now) {
    db.prepare("UPDATE dispatch_offers SET response = 'expired', responded_at = ?, reason = 'timeout' WHERE id = ?")
      .run(now, pending.id);
    return null;
  }
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(pending.booking_id);
  return { offer: pending, booking };
}

module.exports = {
  advanceDispatch,
  tryAccept,
  tryReject,
  getLiveOfferForDriver,
  expireStaleOffers,
  findCandidateDrivers
};