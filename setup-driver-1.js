const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");

const db = new DatabaseSync("./data/app.db");

// Helper: hash password (matches src/auth/index.js scrypt format)
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

// Create driver user
const email = "driver1@example.com";
const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
if (existing) {
  console.log("Driver user already exists. Deleting old...");
  db.prepare("DELETE FROM users WHERE email = ?").run(email);
}

const userId = db.prepare(
  "INSERT INTO users (country_id, role, full_name, email, password_hash, status, email_verified_at) VALUES (1, 'driver', 'Demo Driver', ?, ?, 'active', ?)"
).run(email, hashPassword("DriverPass1234"), new Date().toISOString()).lastInsertRowid;

console.log("Driver user created: id=" + userId + ", email=" + email);
db.close();
