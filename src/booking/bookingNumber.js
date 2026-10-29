const crypto = require('node:crypto');

function pad2(n) { return String(n).padStart(2, '0'); }

function generateBookingNumber(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return 'BK-' + y + m + d + '-' + rand;
}

module.exports = { generateBookingNumber };