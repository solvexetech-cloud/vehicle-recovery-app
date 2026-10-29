process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vra-backup11-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'app.db');
const backupScript = path.join(__dirname, '..', 'scripts', 'backup.ps1');

process.env.DB_PATH = dbPath;
process.env.UPLOADS_DIR = path.join(dataDir, 'uploads');

const { createApp } = require('../src/app');

test('setup: create app + DB with data', () => {
  const ctx = createApp();
  const db = ctx.db;
  const count = db.prepare('SELECT COUNT(*) AS n FROM countries').get().n;
  assert.ok(count >= 6, 'expected 6 countries, got ' + count);
  db.close();
});

test('backup script creates timestamped file', () => {
  if (process.platform !== 'win32') {
    assert.ok(true, 'skipping PS1 backup test on non-Windows');
    return;
  }

  const result = execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', backupScript,
    '-Root', tmp
  ], { encoding: 'utf8', timeout: 60000 });

  // Backup should succeed
  assert.match(result, /Backup created:/, 'backup did not create file. Output: ' + result);
  assert.match(result, /Backup verified OK/, 'backup did not verify. Output: ' + result);

  const backupsDir = path.join(tmp, 'data', 'backups');
  assert.ok(fs.existsSync(backupsDir), 'backups dir missing');

  const backupFiles = fs.readdirSync(backupsDir).filter((f) => /^app-\d{8}-\d{6}\.db$/.test(f));
  assert.ok(backupFiles.length >= 1, 'expected >=1 backup file, got: ' + JSON.stringify(fs.readdirSync(backupsDir)));

  const backupFile = path.join(backupsDir, backupFiles[0]);
  const size = fs.statSync(backupFile).size;
  assert.ok(size > 0, 'backup file is empty');

  // Verify via node:sqlite
  const { DatabaseSync } = require('node:sqlite');
  const bdb = new DatabaseSync(backupFile);
  const tableCount = bdb.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('users','bookings','countries')").get().n;
  bdb.close();
  assert.equal(tableCount, 3, 'backup missing expected tables');
});
