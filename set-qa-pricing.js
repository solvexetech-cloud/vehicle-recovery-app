const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("./data/app.db");
db.prepare(
  "UPDATE country_services SET is_enabled=1, base_fare_minor=5000, per_km_minor=300, fast_surcharge_minor=1000, min_fare_minor=8000 WHERE country_id=1 AND service_code=?"
).run("towing");
db.prepare("UPDATE country_settings SET tax_rate_bp=500, commission_rate_bp=1500 WHERE country_id=1").run();
const svc = db.prepare("SELECT * FROM country_services WHERE country_id=1 AND service_code='towing'").get();
const cs = db.prepare("SELECT tax_rate_bp, commission_rate_bp FROM country_settings WHERE country_id=1").get();
console.log("Towing:", JSON.stringify(svc, null, 2));
console.log("Settings:", JSON.stringify(cs, null, 2));
db.close();
