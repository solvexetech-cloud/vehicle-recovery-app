const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");

const db = new DatabaseSync("./data/app.db");
const now = new Date().toISOString();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

// Clean up any prior demo data
db.prepare("DELETE FROM driver_documents WHERE driver_id IN (SELECT id FROM drivers WHERE user_id IN (SELECT id FROM users WHERE email IN ('driver1@example.com','agency1@example.com')))").run();
db.prepare("DELETE FROM driver_vehicles WHERE driver_id IN (SELECT id FROM drivers WHERE user_id IN (SELECT id FROM users WHERE email IN ('driver1@example.com','agency1@example.com')))").run();
db.prepare("DELETE FROM drivers WHERE user_id IN (SELECT id FROM users WHERE email IN ('driver1@example.com','agency1@example.com'))").run();
db.prepare("DELETE FROM recovery_vehicles WHERE agency_id IN (SELECT id FROM agencies WHERE user_id IN (SELECT id FROM users WHERE email = 'agency1@example.com'))").run();
db.prepare("DELETE FROM agencies WHERE user_id IN (SELECT id FROM users WHERE email = 'agency1@example.com')").run();
db.prepare("DELETE FROM users WHERE email = 'agency1@example.com'").run();

// Agency user + agency
const agencyUserId = db.prepare(
  "INSERT INTO users (country_id, role, full_name, email, password_hash, status, email_verified_at) VALUES (1, 'agency', 'Demo Agency Owner', 'agency1@example.com', ?, 'active', ?)"
).run(hashPassword("AgencyPass1234"), now).lastInsertRowid;

const agencyId = db.prepare(
  "INSERT INTO agencies (country_id, user_id, legal_name, display_name, status, approved_at) VALUES (1, ?, 'Demo Recovery LLC', 'Demo Recovery', 'approved', ?)"
).run(Number(agencyUserId), now).lastInsertRowid;

// Recovery vehicle (flatbed, approved)
const vehicleId = db.prepare(
  "INSERT INTO recovery_vehicles (country_id, agency_id, plate_number, vehicle_type, make, model, year, status) VALUES (1, ?, 'QA-TOW-1', 'flatbed', 'Isuzu', 'NPR', 2023, 'approved')"
).run(Number(agencyId)).lastInsertRowid;

// Driver profile
const driverUserId = db.prepare("SELECT id FROM users WHERE email = 'driver1@example.com'").get().id;
const driverId = db.prepare(
  "INSERT INTO drivers (country_id, user_id, agency_id, current_vehicle_id, status, is_online, last_gps_lat, last_gps_lng, last_gps_at, approved_at, rating_avg, rating_count) VALUES (1, ?, ?, ?, 'approved', 1, 25.3005, 51.5005, ?, ?, 4.8, 24)"
).run(Number(driverUserId), Number(agencyId), Number(vehicleId), now, now).lastInsertRowid;

// Authorize vehicle for driver
db.prepare("INSERT INTO driver_vehicles (driver_id, recovery_vehicle_id, authorized_at) VALUES (?, ?, ?)").run(Number(driverId), Number(vehicleId), now);

// Upload driving license (approved, expires 2099)
db.prepare(
  "INSERT INTO driver_documents (driver_id, doc_type, file_path, mime_type, size_bytes, expires_at, review_status, uploaded_at, updated_at) VALUES (?, 'driving_license', 'demo/license.png', 'image/png', 2048, '2099-12-31', 'approved', ?, ?)"
).run(Number(driverId), now, now);

console.log("Setup complete:");
console.log("  Agency user id:   " + agencyUserId);
console.log("  Agency id:        " + agencyId);
console.log("  Vehicle id:       " + vehicleId + " (plate: QA-TOW-1)");
console.log("  Driver profile:   " + driverId + " (user " + driverUserId + ")");
console.log("  Status:           online, GPS at (25.3005, 51.5005)");

db.close();
