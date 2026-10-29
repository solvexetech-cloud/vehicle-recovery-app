const crypto = require('node:crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(str) {
  const cleaned = String(str).toUpperCase().replace(/=+$/g, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) throw new Error('invalid base32 character: ' + cleaned[i]);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function computeTotp(secretB32, opts = {}) {
  const period = opts.period || 30;
  const digits = opts.digits || 6;
  const algorithm = (opts.algorithm || 'sha1').toLowerCase();
  const time = opts.time !== undefined ? opts.time : Date.now();
  const counter = Math.floor(time / 1000 / period);

  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const key = base32Decode(secretB32);
  const hmac = crypto.createHmac(algorithm, key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % Math.pow(10, digits);
  return String(otp).padStart(digits, '0');
}

function verifyTotp(secretB32, code, opts = {}) {
  const window = opts.window !== undefined ? opts.window : 1;
  const time = opts.time !== undefined ? opts.time : Date.now();
  const period = opts.period || 30;
  const digits = opts.digits || 6;
  const algorithm = (opts.algorithm || 'sha1').toLowerCase();

  const str = String(code || '').trim();
  if (!/^\d+$/.test(str) || str.length !== digits) return false;

  for (let w = -window; w <= window; w++) {
    const t = time + w * period * 1000;
    const candidate = computeTotp(secretB32, { period, digits, algorithm, time: t });
    if (candidate.length === str.length &&
        crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(str))) {
      return true;
    }
  }
  return false;
}

function otpauthUrl({ secret, issuer, accountName, digits = 6, period = 30, algorithm = 'sha1' }) {
  const label = encodeURIComponent(issuer + ':' + accountName);
  const params = new URLSearchParams({
    secret: secret,
    issuer: issuer,
    algorithm: algorithm.toUpperCase(),
    digits: String(digits),
    period: String(period)
  });
  return 'otpauth://totp/' + label + '?' + params.toString();
}

module.exports = { base32Encode, base32Decode, generateSecret, computeTotp, verifyTotp, otpauthUrl };