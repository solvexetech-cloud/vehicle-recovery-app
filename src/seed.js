// GCC countries seed. Arabic strings use \u escapes for PowerShell safety.
const COUNTRIES = [
  { code: 'QA', name_en: 'Qatar',                name_ar: '\u0642\u0637\u0631',                         currency_code: 'QAR', currency_symbol: '\u0631.\u0642', dial_code: '+974', timezone: 'Asia/Qatar',   default_language: 'ar', is_active: 1 },
  { code: 'SA', name_en: 'Saudi Arabia',         name_ar: '\u0627\u0644\u0633\u0639\u0648\u062F\u064A\u0629', currency_code: 'SAR', currency_symbol: '\u0631.\u0633', dial_code: '+966', timezone: 'Asia/Riyadh',  default_language: 'ar', is_active: 0 },
  { code: 'AE', name_en: 'United Arab Emirates', name_ar: '\u0627\u0644\u0625\u0645\u0627\u0631\u0627\u062A', currency_code: 'AED', currency_symbol: '\u062F.\u0625', dial_code: '+971', timezone: 'Asia/Dubai',   default_language: 'ar', is_active: 0 },
  { code: 'KW', name_en: 'Kuwait',               name_ar: '\u0627\u0644\u0643\u0648\u064A\u062A',       currency_code: 'KWD', currency_symbol: '\u062F.\u0643', dial_code: '+965', timezone: 'Asia/Kuwait',  default_language: 'ar', is_active: 0 },
  { code: 'BH', name_en: 'Bahrain',              name_ar: '\u0627\u0644\u0628\u062D\u0631\u064A\u0646', currency_code: 'BHD', currency_symbol: '.\u062F.\u0628', dial_code: '+973', timezone: 'Asia/Bahrain', default_language: 'ar', is_active: 0 },
  { code: 'OM', name_en: 'Oman',                 name_ar: '\u0639\u064F\u0645\u0627\u0646',              currency_code: 'OMR', currency_symbol: '\u0631.\u0639.', dial_code: '+968', timezone: 'Asia/Muscat',  default_language: 'ar', is_active: 0 }
];

function seedCountries(db) {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO countries (code, name_en, name_ar, currency_code, currency_symbol, dial_code, timezone, default_language, is_active) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  let inserted = 0;
  for (const c of COUNTRIES) {
    const r = stmt.run(c.code, c.name_en, c.name_ar, c.currency_code, c.currency_symbol, c.dial_code, c.timezone, c.default_language, c.is_active);
    inserted += (r.changes || 0);
  }
  return inserted;
}

module.exports = { seedCountries, COUNTRIES };