const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function ensureSchemaMigrations(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (" +
    "filename TEXT PRIMARY KEY, " +
    "applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))" +
    ");"
  );
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

function isApplied(db, filename) {
  return !!db.prepare('SELECT 1 AS ok FROM schema_migrations WHERE filename = ?').get(filename);
}

function applyMigration(db, filename) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations(filename) VALUES (?)').run(filename);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw new Error('Migration failed: ' + filename + ': ' + e.message);
  }
}

function runMigrations(db, logger) {
  ensureSchemaMigrations(db);
  const applied = [];
  for (const f of listMigrationFiles()) {
    if (!isApplied(db, f)) {
      applyMigration(db, f);
      applied.push(f);
      if (logger) logger.info('migration.applied', { filename: f });
    }
  }
  if (logger && applied.length === 0) logger.info('migration.noop');
  return applied;
}

module.exports = { runMigrations, listMigrationFiles };