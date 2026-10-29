process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { openDatabase } = require('../src/db');
const { runMigrations, listMigrationFiles } = require('../src/migrate');
const { seedCountries } = require('../src/seed');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-mig-'));
const dbPath = path.join(tmp, 'm.db');

test('fresh DB: all migrations applied', () => {
  const db = openDatabase(dbPath);
  const applied = runMigrations(db);
  assert.equal(applied.length, listMigrationFiles().length);
  db.close();
});

test('seedCountries inserts all 6 GCC countries, QA active', () => {
  const db = openDatabase(dbPath);
  runMigrations(db);
  seedCountries(db);
  const n = db.prepare('SELECT COUNT(*) AS n FROM countries').get().n;
  assert.equal(n, 6);
  const qa = db.prepare("SELECT is_active, currency_code FROM countries WHERE code = 'QA'").get();
  assert.equal(qa.is_active, 1);
  assert.equal(qa.currency_code, 'QAR');
  const inactive = db.prepare('SELECT COUNT(*) AS n FROM countries WHERE is_active = 0').get().n;
  assert.equal(inactive, 5);
  db.close();
});

test('re-run migrations + seed are idempotent', () => {
  const db = openDatabase(dbPath);
  const applied = runMigrations(db);
  assert.equal(applied.length, 0);
  const insertedAgain = seedCountries(db);
  assert.equal(insertedAgain, 0);
  db.close();
});

test('all required tables exist', () => {
  const db = openDatabase(dbPath);
  runMigrations(db);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const required = [
    'countries','users','agencies','drivers','recovery_vehicles','customer_vehicles',
    'bookings','booking_status_history','payments','payment_events','audit_logs',
    'sessions','password_reset_tokens','idempotency_keys','schema_migrations'
  ];
  for (const t of required) assert.ok(names.includes(t), 'missing table: ' + t);
  db.close();
});

test('foreign keys enforced (invalid country_id rejected)', () => {
  const db = openDatabase(dbPath);
  runMigrations(db);
  assert.throws(() => {
    db.prepare(
      "INSERT INTO users (country_id, role, full_name, email, password_hash) VALUES (?, ?, ?, ?, ?)"
    ).run(999999, 'customer', 'Ghost', 'ghost@example.com', 'x');
  }, /FOREIGN KEY/i);
  db.close();
});

test('CHECK constraint rejects invalid booking status', () => {
  const db = openDatabase(dbPath);
  runMigrations(db);
  seedCountries(db);
  const custId = db.prepare(
    "INSERT INTO users (country_id, role, full_name, email, password_hash, status) VALUES (1, 'customer', 'A', 'a@b.c', 'h', 'active')"
  ).run().lastInsertRowid;
  assert.throws(() => {
    db.prepare(
      'INSERT INTO bookings (booking_number, country_id, customer_id, service_type, customer_vehicle_snapshot_json, pickup_lat, pickup_lng, destination_lat, destination_lng, fare_estimate_json, agreed_fare_minor, currency_code, status) ' +
      "VALUES ('BK-1', 1, ?, 'towing', '{}', 0, 0, 0, 0, '{}', 100, 'QAR', 'not_a_real_status')"
    ).run(custId);
  }, /CHECK/i);
  db.close();
});