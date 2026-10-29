const express = require('express');

function routes(db) {
  const r = express.Router();
  r.get('/', (req, res) => {
    const countries = db.prepare(
      'SELECT code, name_en, name_ar, currency_code, currency_symbol, dial_code, timezone, default_language FROM countries WHERE is_active = 1 ORDER BY name_en'
    ).all();
    res.json({ countries });
  });
  return r;
}

module.exports = { routes };