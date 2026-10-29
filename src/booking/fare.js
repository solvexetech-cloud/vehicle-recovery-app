const EARTH_RADIUS_KM = 6371;
function toRad(deg) { return (deg * Math.PI) / 180; }

function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function roundKm(km) {
  return Math.round(km * 100) / 100;
}

/**
 * Compute fare estimate for a recovery booking.
 *
 * Inputs:
 *   countrySettings { tax_rate_bp, cancellation_fee_minor, free_cancel_seconds }
 *   serviceRow      { service_code, base_fare_minor, per_km_minor, fast_surcharge_minor, min_fare_minor, is_enabled }
 *   pickup          { lat, lng }
 *   destination     { lat, lng }
 *   serviceLevel    'normal' | 'fast'
 *   currencyCode    e.g. 'QAR'
 *
 * Returns object with full breakdown in minor units + human-readable km.
 * Distance is round-trip (driver goes pickup -> destination, but recovery usually charged one-way loaded).
 * Per master plan: components = base fare + loaded distance + service fee + fast surcharge + tax.
 */
function computeFareEstimate({ countrySettings, serviceRow, pickup, destination, serviceLevel, currencyCode }) {
  if (!serviceRow.is_enabled) {
    return { error: 'service_not_enabled' };
  }
  const distanceKm = roundKm(haversineKm(pickup.lat, pickup.lng, destination.lat, destination.lng));

  const baseFare = serviceRow.base_fare_minor;
  const distanceFare = Math.round(serviceRow.per_km_minor * distanceKm);
  const fastSurcharge = serviceLevel === 'fast' ? serviceRow.fast_surcharge_minor : 0;

  let subtotal = baseFare + distanceFare + fastSurcharge;
  if (subtotal < serviceRow.min_fare_minor) {
    subtotal = serviceRow.min_fare_minor;
  }

  const taxMinor = Math.round((subtotal * countrySettings.tax_rate_bp) / 10000);
  const totalMinor = subtotal + taxMinor;

  return {
    ok: true,
    currency_code: currencyCode,
    service_code: serviceRow.service_code,
    service_level: serviceLevel,
    distance_km: distanceKm,
    base_fare_minor: baseFare,
    distance_fare_minor: distanceFare,
    fast_surcharge_minor: fastSurcharge,
    min_fare_minor: serviceRow.min_fare_minor,
    subtotal_minor: subtotal,
    tax_rate_bp: countrySettings.tax_rate_bp,
    tax_minor: taxMinor,
    total_minor: totalMinor,
    cancellation_policy: {
      fee_minor: countrySettings.cancellation_fee_minor,
      free_cancel_seconds: countrySettings.free_cancel_seconds
    }
  };
}

module.exports = { haversineKm, roundKm, computeFareEstimate };