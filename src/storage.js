const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ALLOWED_MIMES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'application/pdf': '.pdf'
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function saveBase64({ uploadsDir, subdir, dataUrl, maxBytes }) {
  if (typeof dataUrl !== 'string') {
    return { error: 'invalid_base64' };
  }
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return { error: 'invalid_data_url' };
  const mime = m[1].toLowerCase();
  if (!ALLOWED_MIMES[mime]) return { error: 'unsupported_mime', mime };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) return { error: 'empty_file' };
  if (buf.length > maxBytes) return { error: 'file_too_large', size: buf.length, max: maxBytes };

  const ext = ALLOWED_MIMES[mime];
  const filename = crypto.randomBytes(16).toString('hex') + ext;
  const fullDir = path.join(uploadsDir, subdir);
  ensureDir(fullDir);
  const fullPath = path.join(fullDir, filename);
  fs.writeFileSync(fullPath, buf);
  const relativePath = path.join(subdir, filename).replace(/\\/g, '/');
  return { ok: true, relativePath, mime, size: buf.length };
}

function deleteFile({ uploadsDir, relativePath }) {
  try {
    const full = path.join(uploadsDir, relativePath);
    if (fs.existsSync(full)) fs.unlinkSync(full);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { saveBase64, deleteFile, ALLOWED_MIMES };