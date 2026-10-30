const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("./data/app.db");
const now = new Date().toISOString();

// Force driver online + fresh GPS
const drv = db.prepare("SELECT id, user_id FROM drivers WHERE user_id = (SELECT id FROM users WHERE email = 'driver1@example.com')").get();
db.prepare("UPDATE drivers SET is_online = 1, last_gps_lat = 25.3005, last_gps_lng = 51.5005, last_gps_at = ? WHERE id = ?").run(now, drv.id);

// Verify eligibility
const doc = db.prepare("SELECT review_status, expires_at FROM driver_documents WHERE driver_id = ? AND doc_type = 'driving_license'").get(drv.id);
const veh = db.prepare("SELECT rv.status FROM drivers d JOIN recovery_vehicles rv ON rv.id = d.current_vehicle_id WHERE d.id = ?").get(drv.id);

console.log("Driver online:", drv.id);
console.log("GPS fresh:", now);
console.log("License:", doc.review_status, "expires:", doc.expires_at);
console.log("Vehicle:", veh ? veh.status : "none");
db.close();
